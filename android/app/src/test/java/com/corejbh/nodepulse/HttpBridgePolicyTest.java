package com.corejbh.nodepulse;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.IOException;
import java.net.InetAddress;

import org.junit.Test;

/**
 * The policy the native bridge applies before it opens a connection, and the navigation
 * policy the WebView client applies to a URL.
 *
 * <p>None of this needs a device: the host allowlist, the request-id shape, the address
 * classes that may never be contacted and the redirect rule are all static decisions over
 * a string. {@code HttpBridgeChunkTest} covers the other half of the bridge — how a body
 * is handed back.
 */
public class HttpBridgePolicyTest {

    private static InetAddress addr(String s) throws IOException {
        return InetAddress.getByName(s);
    }

    /* ---- the request id the page may send ---------------------------------------- */

    @Test
    public void requestIdAcceptsTheShapeThePageSends() {
        assertTrue(MainActivity.HttpBridge.validId("1"));
        assertTrue(MainActivity.HttpBridge.validId("42"));
        assertTrue(MainActivity.HttpBridge.validId("req-7_a"));
        assertTrue(MainActivity.HttpBridge.validId("0123456789012345678901234567890x"));
    }

    @Test
    public void requestIdRefusesAnythingElse() {
        assertFalse(MainActivity.HttpBridge.validId(null));
        assertFalse(MainActivity.HttpBridge.validId(""));
        assertFalse(MainActivity.HttpBridge.validId("1 2"));
        assertFalse(MainActivity.HttpBridge.validId("1\"2"));
        assertFalse(MainActivity.HttpBridge.validId("1);alert(1);//"));
        assertFalse(MainActivity.HttpBridge.validId("1\n2"));
        assertFalse(MainActivity.HttpBridge.validId("a".repeat(33)));
        assertFalse(MainActivity.HttpBridge.validId("héllo"));
    }

    /* ---- the host allowlist ------------------------------------------------------- */

    @Test
    public void allowedHostsAreTheFourThePageReads() {
        assertTrue(MainActivity.HttpBridge.allowed("https://bitnodes.io/api/v1/snapshots/latest/?field=coordinates"));
        assertTrue(MainActivity.HttpBridge.allowed("https://mempool.space/api/blocks/tip/height"));
        assertTrue(MainActivity.HttpBridge.allowed("https://mempool.emzy.de/api/v1/ws"));
        assertTrue(MainActivity.HttpBridge.allowed("https://mempool.ninja/api/v1/lightning/channels-geo"));
    }

    @Test
    public void everythingElseIsRefused() {
        assertFalse(MainActivity.HttpBridge.allowed("http://bitnodes.io/api/v1/snapshots/latest/"));
        assertFalse(MainActivity.HttpBridge.allowed("https://example.com/"));
        assertFalse(MainActivity.HttpBridge.allowed("https://www.bitnodes.io/"));
        assertFalse(MainActivity.HttpBridge.allowed("https://bitnodes.io.example.com/"));
        assertFalse(MainActivity.HttpBridge.allowed("https://bitnodes.io:8443/"));
        assertFalse(MainActivity.HttpBridge.allowed("https://user:pass@bitnodes.io/"));
        assertFalse(MainActivity.HttpBridge.allowed("file:///android_asset/index.html"));
        assertFalse(MainActivity.HttpBridge.allowed(null));
        assertFalse(MainActivity.HttpBridge.allowed("not a url"));
    }

    /* ---- redirects ---------------------------------------------------------------- */

    @Test
    public void aRedirectToAnotherHostIsBlocked() {
        try {
            MainActivity.HttpBridge.nextHop("https://mempool.space/api/v1/blocks", "https://example.com/x");
            fail("a redirect off the allowlist must not be followed");
        } catch (IOException expected) {
            assertTrue(expected.getMessage().contains("redirect"));
        }
        try {
            MainActivity.HttpBridge.nextHop("https://mempool.space/api/v1/blocks", "http://mempool.space/x");
            fail("a redirect to plain http must not be followed");
        } catch (IOException expected) {
            // expected
        }
        try {
            MainActivity.HttpBridge.nextHop("https://mempool.space/api/v1/blocks", null);
            fail("a redirect without a location must fail");
        } catch (IOException expected) {
            // expected
        }
    }

    @Test
    public void aRedirectInsideTheAllowlistIsFollowed() throws IOException {
        assertEquals("https://mempool.space/api/v1/blocks/tip",
                MainActivity.HttpBridge.nextHop("https://mempool.space/api/v1/blocks", "/api/v1/blocks/tip"));
        assertEquals("https://mempool.emzy.de/api/v1/blocks",
                MainActivity.HttpBridge.nextHop("https://mempool.space/api/v1/blocks", "https://mempool.emzy.de/api/v1/blocks"));
    }

    /* ---- names that resolve somewhere private ------------------------------------ */

    @Test
    public void privateAndLocalAddressesAreBlocked() throws IOException {
        assertTrue(MainActivity.HttpBridge.blockedAddress(addr("127.0.0.1")));
        assertTrue(MainActivity.HttpBridge.blockedAddress(addr("::1")));
        assertTrue(MainActivity.HttpBridge.blockedAddress(addr("0.0.0.0")));
        assertTrue(MainActivity.HttpBridge.blockedAddress(addr("10.0.0.5")));
        assertTrue(MainActivity.HttpBridge.blockedAddress(addr("172.16.4.4")));
        assertTrue(MainActivity.HttpBridge.blockedAddress(addr("192.168.0.1")));
        assertTrue(MainActivity.HttpBridge.blockedAddress(addr("169.254.169.254")));
        assertTrue(MainActivity.HttpBridge.blockedAddress(addr("100.64.0.1")));
        assertTrue(MainActivity.HttpBridge.blockedAddress(addr("224.0.0.1")));
        assertTrue(MainActivity.HttpBridge.blockedAddress(addr("fe80::1")));
        assertTrue(MainActivity.HttpBridge.blockedAddress(addr("fd00::1")));
        assertTrue(MainActivity.HttpBridge.blockedAddress(addr("::ffff:127.0.0.1")));
        assertTrue(MainActivity.HttpBridge.blockedAddress(null));
    }

    @Test
    public void publicAddressesAreAllowed() throws IOException {
        assertFalse(MainActivity.HttpBridge.blockedAddress(addr("1.1.1.1")));
        assertFalse(MainActivity.HttpBridge.blockedAddress(addr("8.8.8.8")));
        assertFalse(MainActivity.HttpBridge.blockedAddress(addr("2606:4700:4700::1111")));
    }

    @Test
    public void anUnresolvableHostIsNotSafe() {
        /* ".invalid" never resolves (RFC 6761), so this asks hostSafe() for its answer to a
           name that has no address rather than for a network condition. */
        assertFalse(MainActivity.HttpBridge.hostSafe("nothing.invalid"));
        assertFalse(MainActivity.HttpBridge.hostSafe(""));
        assertFalse(MainActivity.HttpBridge.hostSafe(null));
    }

    /* ---- navigation ---------------------------------------------------------------- */

    @Test
    public void navigationOnlyAllowsTheBundledAsset() {
        assertFalse(MainActivity.navigationBlocked("file:///android_asset/index.html"));
        assertFalse(MainActivity.navigationBlocked("file:///android_asset/index.html#panel"));
        assertFalse(MainActivity.navigationBlocked("file:///android_asset/index.html?x=1"));
        assertTrue(MainActivity.navigationBlocked("https://example.com/"));
        assertTrue(MainActivity.navigationBlocked("file:///android_asset/other.html"));
        assertTrue(MainActivity.navigationBlocked("javascript:alert(1)"));
        assertTrue(MainActivity.navigationBlocked("intent://scan/#Intent;scheme=zxing;end"));
        assertTrue(MainActivity.navigationBlocked(null));
    }
}
