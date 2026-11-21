package com.jbitmstr.nodepulse;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.GZIPInputStream;

/**
 * The whole application is one HTML file (assets/index.html) built from src/ by build.py.
 * This shell gives it a full-screen, dark, dependency-free WebView, plus one thing the
 * WebView cannot do on its own: bitnodes.io answers without an Access-Control-Allow-Origin
 * header, so the page's L1 dataset would be blocked by CORS. {@link HttpBridge} performs
 * that GET natively and hands the body back to the page as text, which is the same data
 * the site itself serves — nothing is added, cached or rewritten.
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
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient());

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(false);
        // The page is a local file that talks to https APIs: universal access from file
        // URLs lets fetch/WebSocket reach mempool.space without a local proxy.
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMediaPlaybackRequiresUserGesture(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            s.setSafeBrowsingEnabled(false);
        }

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

    /**
     * fetch(id, url) -> window.NPBridgeOnData(id, ok, body)
     *
     * Only the hosts the app actually reads are allowed, so the interface cannot be used
     * as an open proxy from the page. The body is passed through unchanged.
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

        private final WebView web;
        private final ExecutorService pool = Executors.newFixedThreadPool(3);

        HttpBridge(WebView web) {
            this.web = web;
        }

        void shutdown() {
            pool.shutdownNow();
        }

        private static boolean allowed(String url) {
            try {
                URL u = new URL(url);
                if (!"https".equalsIgnoreCase(u.getProtocol())) return false;
                String host = u.getHost();
                if (host == null) return false;
                for (String h : HOSTS) {
                    if (host.equals(h)) return true;
                }
                return false;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public void fetch(final String id, final String url) {
            if (id == null || url == null || !allowed(url)) {
                deliver(id, false, "");
                return;
            }
            pool.execute(new Runnable() {
                @Override
                public void run() {
                    String body = null;
                    HttpURLConnection c = null;
                    try {
                        c = (HttpURLConnection) new URL(url).openConnection();
                        c.setInstanceFollowRedirects(true);
                        c.setConnectTimeout(CONNECT_MS);
                        c.setReadTimeout(READ_MS);
                        c.setRequestMethod("GET");
                        c.setRequestProperty("User-Agent", UA);
                        c.setRequestProperty("Accept", "application/json");
                        c.setRequestProperty("Accept-Encoding", "gzip");
                        int code = c.getResponseCode();
                        if (code < 200 || code >= 300) {
                            deliver(id, false, "");
                            return;
                        }
                        InputStream in = c.getInputStream();
                        String enc = c.getContentEncoding();
                        if (enc != null && enc.toLowerCase().contains("gzip")) {
                            in = new GZIPInputStream(in);
                        }
                        BufferedReader r = new BufferedReader(new InputStreamReader(in, "UTF-8"));
                        StringBuilder sb = new StringBuilder(65536);
                        char[] buf = new char[8192];
                        int n;
                        while ((n = r.read(buf)) != -1) {
                            sb.append(buf, 0, n);
                            if (sb.length() > MAX_BYTES) break;
                        }
                        r.close();
                        body = sb.toString();
                    } catch (Exception e) {
                        body = null;
                    } finally {
                        if (c != null) c.disconnect();
                    }
                    if (body == null) deliver(id, false, "");
                    else deliver(id, true, body);
                }
            });
        }

        private void deliver(final String id, final boolean ok, final String body) {
            if (web == null) return;
            web.post(new Runnable() {
                @Override
                public void run() {
                    String js = "window.NPBridgeOnData&&window.NPBridgeOnData("
                            + JSONObject.quote(id == null ? "" : id) + ","
                            + (ok ? "true" : "false") + ","
                            + JSONObject.quote(body == null ? "" : body) + ")";
                    try {
                        web.evaluateJavascript(js, null);
                    } catch (Exception ignored) {
                    }
                }
            });
        }
    }
}
