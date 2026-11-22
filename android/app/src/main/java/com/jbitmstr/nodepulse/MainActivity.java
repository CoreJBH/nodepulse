package com.jbitmstr.nodepulse;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.lang.ref.WeakReference;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.zip.GZIPInputStream;

/**
 * The whole application is one HTML file (assets/index.html) built from src/ by build.py.
 * This shell gives it a full-screen, dark, dependency-free WebView, plus one thing the
 * WebView cannot do on its own: bitnodes.io answers without an Access-Control-Allow-Origin
 * header, so the page's L1 dataset would be blocked by CORS. {@link HttpBridge} performs
 * that GET natively and hands the body back to the page as text, which is the same data
 * the site itself serves — nothing is added, cached or rewritten.
 *
 * Security posture: the WebView may only ever show the bundled asset. File access, file-URL
 * access and universal access from file URLs are all off; the page reaches its JSON APIs
 * over https (mempool.space sends Access-Control-Allow-Origin: *) and, where CORS blocks it,
 * through the bridge, whose host allowlist is checked again on every redirect hop.
 */
public class MainActivity extends Activity {

    private static final String APP_URL = "file:///android_asset/index.html";
    private static final int BG = 0xFF040914;

    private WebView web;
    private HttpBridge bridge;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        Window window = getWindow();
        window.setStatusBarColor(BG);
        window.setNavigationBarColor(BG);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }

        web = new WebView(this);
        web.setBackgroundColor(BG);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setWebViewClient(new AppClient());
        web.setWebChromeClient(new WebChromeClient());

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        // The page is the one bundled asset. Nothing on disk or in a content provider is
        // readable from it, and a file:// document gets no access to other origins: the
        // only network path is https with CORS, or the bridge below.
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        // Stated rather than left to the platform default: nothing in this app needs an
        // insecure subresource, so an https page may never pull one in over http.
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMediaPlaybackRequiresUserGesture(false);
        // Safe Browsing stays at the platform default (on): nothing in the app needs it off.

        bridge = new HttpBridge(web);
        web.addJavascriptInterface(bridge, "NPBridge");

        setContentView(web);
        if (state != null) {
            web.restoreState(state);
        } else {
            web.loadUrl(APP_URL);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onPause() {
        if (web != null) {
            web.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) {
            web.onResume();
        }
    }

    @Override
    protected void onDestroy() {
        if (bridge != null) {
            bridge.shutdown();
            bridge = null;
        }
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    /** True only for the bundled page itself (fragments and query strings included). */
    private static boolean isAppUrl(String url) {
        if (url == null) return false;
        if (url.equals(APP_URL)) return true;
        return url.startsWith(APP_URL + "#") || url.startsWith(APP_URL + "?");
    }

    /**
     * The app never leaves the bundled asset: no link, redirect or injected frame may
     * navigate the WebView to another file, content: or web page. A TLS error is a hard
     * stop, never a "continue anyway".
     */
    private static final class AppClient extends WebViewClient {

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request == null ? null : request.getUrl();
            return u == null || !isAppUrl(u.toString());
        }

        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return !isAppUrl(url);
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            if (handler != null) handler.cancel();
        }
    }

    /**
     * fetch(id, url) -> window.NPBridgeOnData(id, ok, body)
     *
     * Only the hosts the app actually reads are allowed, so the interface cannot be used
     * as an open proxy from the page. Redirects are followed by hand so every hop is
     * re-checked against that same allowlist. The body is passed through unchanged.
     */
    static final class HttpBridge {

        private static final String[] HOSTS = {
                "bitnodes.io",
                "www.bitnodes.io",
                "btcnodes.io",
                "mempool.space",
                "mempool.emzy.de",
                "mempool.ninja"
        };
        private static final String UA = "NODEPULSE/1.1 (Android; +https://github.com/CoreJBH/nodepulse)";
        private static final int CONNECT_MS = 12000;
        private static final int READ_MS = 25000;
        private static final int MAX_BYTES = 4 * 1024 * 1024;
        private static final int MAX_REDIRECTS = 5;

        private final WeakReference<WebView> web;
        private final ExecutorService pool = Executors.newFixedThreadPool(3);
        private volatile boolean destroyed = false;

        HttpBridge(WebView web) {
            this.web = new WeakReference<>(web);
        }

        void shutdown() {
            destroyed = true;
            pool.shutdownNow();
        }

        private static boolean allowed(String url) {
            try {
                URL u = new URL(url);
                if (!"https".equalsIgnoreCase(u.getProtocol())) return false;
                // user:password@host is not a shape this app ever builds, and a browser
                // and URL parser disagree about where the host starts, so reject it.
                if (u.getUserInfo() != null) return false;
                if (u.getPort() != -1 && u.getPort() != 443) return false;
                String host = u.getHost();
                if (host == null) return false;
                for (String h : HOSTS) {
                    // DNS names are case-insensitive, and URL does not normalise the host
                    if (host.equalsIgnoreCase(h)) return true;
                }
                return false;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public void fetch(final String id, final String url) {
            if (destroyed || id == null || url == null || !allowed(url)) {
                deliver(id, false, "");
                return;
            }
            try {
                pool.execute(new Runnable() {
                    @Override
                    public void run() {
                        String body = null;
                        try {
                            body = download(url);
                        } catch (Exception e) {
                            body = null;
                        }
                        if (body == null) deliver(id, false, "");
                        else deliver(id, true, body);
                    }
                });
            } catch (RejectedExecutionException e) {
                deliver(id, false, "");
            }
        }

        /** One GET, following at most {@link #MAX_REDIRECTS} hops, each re-validated. */
        private static String download(String raw) throws IOException {
            String url = raw;
            for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
                if (!allowed(url)) throw new IOException("blocked host");
                HttpURLConnection c = null;
                try {
                    c = (HttpURLConnection) new URL(url).openConnection();
                    c.setInstanceFollowRedirects(false);
                    c.setConnectTimeout(CONNECT_MS);
                    c.setReadTimeout(READ_MS);
                    c.setRequestMethod("GET");
                    c.setRequestProperty("User-Agent", UA);
                    c.setRequestProperty("Accept", "application/json");
                    c.setRequestProperty("Accept-Encoding", "gzip");
                    int code = c.getResponseCode();
                    if (code >= 300 && code < 400) {
                        String loc = c.getHeaderField("Location");
                        if (loc == null || loc.isEmpty()) throw new IOException("redirect without location");
                        url = new URL(new URL(url), loc).toString();
                        continue;
                    }
                    if (code < 200 || code >= 300) throw new IOException("HTTP " + code);
                    return readBody(c);
                } finally {
                    if (c != null) c.disconnect();
                }
            }
            throw new IOException("too many redirects");
        }

        private static String readBody(HttpURLConnection c) throws IOException {
            InputStream raw = c.getInputStream();
            String enc = c.getContentEncoding();
            InputStream in = (enc != null && enc.toLowerCase(Locale.ROOT).contains("gzip"))
                    ? new GZIPInputStream(raw) : raw;
            StringBuilder sb = new StringBuilder(65536);
            try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
                char[] buf = new char[8192];
                int n;
                while ((n = r.read(buf)) != -1) {
                    sb.append(buf, 0, n);
                    if (sb.length() > MAX_BYTES) throw new IOException("response too large");
                }
            }
            return sb.toString();
        }

        /**
         * A JS string literal for {@code s}: JSONObject.quote() does the escaping, then
         * U+2028 and U+2029 become \u2028 and \u2029. Both are line terminators to a
         * JavaScript parser (only since ES2019 are they legal inside a string literal),
         * and quote() leaves them raw, so an answer that carried one — an alias, a client
         * version — used to turn the injected call into a syntax error on an older
         * WebView and lose the data. JSON.parse() accepts the escapes, so the page sees
         * exactly the same characters.
         */
        private static String jsStringLiteral(String s) {
            String quoted = JSONObject.quote(s == null ? "" : s);
            return quoted.replace(String.valueOf((char) 0x2028), "\\u2028")
                    .replace(String.valueOf((char) 0x2029), "\\u2029");
        }

        private void deliver(final String id, final boolean ok, final String body) {
            if (destroyed) return;
            final WebView w = web.get();
            if (w == null) return;
            w.post(new Runnable() {
                @Override
                public void run() {
                    if (destroyed) return;
                    WebView v = web.get();
                    if (v == null) return;
                    String js = "window.NPBridgeOnData&&window.NPBridgeOnData("
                            + jsStringLiteral(id) + ","
                            + (ok ? "true" : "false") + ","
                            + jsStringLiteral(body) + ")";
                    try {
                        v.evaluateJavascript(js, null);
                    } catch (Exception ignored) {
                    }
                }
            });
        }
    }
}
