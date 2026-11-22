package com.jbitmstr.nodepulse;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
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
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
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

        installWebView();
        if (!restoreWebViewState(state)) {
            web.loadUrl(APP_URL);
        }
    }

    /**
     * Creates the WebView, its settings, the bridge and the full-screen content view.
     * Called from onCreate() and again from the renderer-death recovery, so a WebView the
     * system has destroyed is never reused: the new one is built exactly like the first.
     */
    @SuppressLint("SetJavaScriptEnabled")
    private void installWebView() {
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
    }

    /**
     * The renderer runs in its own process, which the system may kill at any time (memory
     * pressure, a crash inside it). Since Android 8 the default answer to that is to kill
     * the whole app — which looks like a silent exit — unless the client returns true from
     * onRenderProcessGone(). This takes the dead WebView and its bridge apart in the
     * documented order and puts a fresh WebView in the same window, so the app reloads the
     * bundled asset and comes back instead of vanishing.
     */
    private void recoverFromRendererGone() {
        WebView dead = web;
        web = null;
        if (bridge != null) {
            bridge.shutdown();
            bridge = null;
        }
        if (dead != null) {
            detach(dead);
            dead.destroy();
        }
        installWebView();
        if (web != null) web.loadUrl(APP_URL);
    }

    /** Takes a WebView out of the view hierarchy before it is destroyed. */
    private static void detach(WebView v) {
        ViewParent parent = v.getParent();
        if (parent instanceof ViewGroup) {
            ((ViewGroup) parent).removeView(v);
        }
    }

    /**
     * saveState() writes the WebView's back-forward list; restoreState() returns that list,
     * or null when the bundle carried nothing usable — a killed process, a state saved by a
     * different WebView version, an empty list. The old code loaded the app only when the
     * bundle was null, so a restore that answered null left the WebView on a blank page for
     * good. Anything short of a real restore now falls back to the bundled asset.
     */
    private boolean restoreWebViewState(Bundle state) {
        if (state == null || web == null) return false;
        try {
            return web.restoreState(state) != null;
        } catch (RuntimeException e) {
            return false;
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        /* web is null between a renderer death and its replacement, and saving the state
           of a WebView that has been destroyed is not defined. */
        if (web != null) web.saveState(out);
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
            /* Out of the hierarchy first: a WebView destroyed while still attached keeps
               its window and its renderer bound to an Activity that is going away. */
            detach(web);
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
     *
     * <p>Not static: the renderer-death callback below rebuilds the shell through the
     * Activity it belongs to. One instance lives per WebView, and both are replaced
     * together, so the reference never outlives the view it was made for.
     */
    private final class AppClient extends WebViewClient {

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

        /**
         * Runs on the UI thread when the renderer process is gone (API 26+). Returning
         * true says the app handled it and keeps the process alive; the WebView that is
         * handed here is already unusable, whatever the detail says, so it is replaced
         * rather than reused. On API 24–25 the platform does not call this and the
         * callback simply never fires.
         */
        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            /* The Activity may already be on its way out; there is nothing to rebuild then,
               and returning true still keeps the process alive. */
            if (isFinishing() || isDestroyed()) return true;
            recoverFromRendererGone();
            return true;
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
                "mempool.space",
                "mempool.emzy.de",
                "mempool.ninja"
        };
        private static final String UA = "NODEPULSE/1.1 (Android; +https://github.com/CoreJBH/nodepulse)";
        private static final int CONNECT_MS = 12000;
        private static final int READ_MS = 25000;
        /* The body cap counts characters, and a character costs two bytes in the VM.
           3 M characters (6 MB) is above the largest answer this app reads — channels-geo
           is about 1.6 MB of JSON today. */
        private static final int MAX_BODY_CHARS = 3 * 1024 * 1024;
        /* A body is handed to the page in chunks of this size, not built into one
           evaluateJavascript() call. One script string for a 3 M-char answer needed the
           body, its quoted copy (one character can grow to six: backslash-uXXXX) and the
           finished call on the heap at the same time, per thread, up to POOL_MAX threads
           at once — tens of megabytes on a low-end device, and the OOM the review
           flagged. A chunk bounds each script string to about 0.4 MB even in the worst
           quoting case, so POOL_MAX concurrent deliveries stay within a couple of
           megabytes whatever the body size; the page reassembles the parts by their
           sequence number. */
        private static final int MAX_CHUNK_CHARS = 32 * 1024;
        private static final int MAX_REDIRECTS = 5;
        /* Two workers, one spare, 32 waiting. Boot fires about eleven concurrent GETs
           at once (tip, blocks, mempool, recent txs, fees, hashrate, difficulty, pools,
           Lightning stats and countries, plus the Bitnodes snapshot pair), and a queue
           sized to the burst absorbs it: a request beyond this is still refused at once
           so it falls to the next mirror or to the bundled snapshot instead of piling
           up, but the boot burst itself is never one of the refused. */
        private static final int POOL_CORE = 2;
        private static final int POOL_MAX = 3;
        private static final int POOL_QUEUE = 32;
        private static final long POOL_KEEP_ALIVE_S = 30L;

        private final WeakReference<WebView> web;
        /* Bounded on purpose. newFixedThreadPool(3) held an unbounded LinkedBlockingQueue:
           every call the page made queued its own Runnable, and the thread that finished a
           response kept a multi-megabyte body alive until the UI thread had posted it. A
           ThreadPoolExecutor with a fixed-size ArrayBlockingQueue puts a ceiling on both
           the queued work and the bodies waiting to be handed over. */
        private final ThreadPoolExecutor pool = new ThreadPoolExecutor(
                POOL_CORE, POOL_MAX, POOL_KEEP_ALIVE_S, TimeUnit.SECONDS,
                new ArrayBlockingQueue<Runnable>(POOL_QUEUE),
                new ThreadFactory() {
                    private final AtomicInteger seq = new AtomicInteger();

                    @Override
                    public Thread newThread(Runnable r) {
                        Thread t = new Thread(r, "nodepulse-http-" + seq.incrementAndGet());
                        t.setDaemon(true);
                        return t;
                    }
                });
        private volatile boolean destroyed = false;

        HttpBridge(WebView web) {
            this.web = new WeakReference<>(web);
            // No request, no thread: an idle app holds none of the pool.
            pool.allowCoreThreadTimeOut(true);
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
            // Pre-sized from Content-Length when the server sends one, and never larger
            // than the cap: a body that arrives in one piece then costs one allocation.
            int hint = c.getContentLength();
            int capacity = hint > 0 ? Math.min(hint + 1024, MAX_BODY_CHARS) : 65536;
            StringBuilder sb = new StringBuilder(Math.max(capacity, 4096));
            try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
                char[] buf = new char[8192];
                int n;
                while ((n = r.read(buf)) != -1) {
                    if (sb.length() + n > MAX_BODY_CHARS) throw new IOException("response too large");
                    sb.append(buf, 0, n);
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
            // replace() answers the same instance when nothing matches, so these two copies
            // only happen for an answer that really carries a line separator — but check
            // first anyway: on a large body the search is cheap and the copy is not.
            String ls = String.valueOf((char) 0x2028);
            String ps = String.valueOf((char) 0x2029);
            if (quoted.indexOf(ls) >= 0) quoted = quoted.replace(ls, "\\u2028");
            if (quoted.indexOf(ps) >= 0) quoted = quoted.replace(ps, "\\u2029");
            return quoted;
        }

        /**
         * Hands the answer to the page. A failure is one call; a body too large to hand
         * over is a single failure call too; a body is one call per chunk plus a final
         * call that carries the last chunk and its sequence number, so the page joins the
         * parts in order however the UI thread interleaved the posts. Every script string
         * is built on the calling thread — a pool worker, or the WebView's JS thread on
         * the refusal path — and the UI thread only hands the finished strings over.
         */
        private void deliver(final String id, final boolean ok, final String body) {
            if (destroyed || id == null) return;
            final WebView w = web.get();
            if (w == null) return;
            if (!ok || body == null) {
                post(w, callScript(id, false, "", true, 0));
                return;
            }
            if (body.length() > MAX_BODY_CHARS) {
                // Too large to hand over: fail the request so the page falls to the next
                // mirror or to the bundled snapshot instead of holding the copy.
                post(w, callScript(id, false, "", true, 0));
                return;
            }
            int total = body.length();
            int seq = 0;
            int off = 0;
            while (off < total) {
                int end = chunkEnd(body, off, MAX_CHUNK_CHARS);
                seq++;
                String js = callScript(id, true, body.substring(off, end),
                        end == total, seq);
                if (js == null) return;
                post(w, js);
                /* Continue where this chunk ended, not at off + MAX_CHUNK_CHARS: when a
                   surrogate pair straddled the boundary the high half was moved into the
                   next chunk, so the next chunk starts one character earlier. Stepping by
                   the full size would skip that character and lose it. */
                off = end;
            }
            if (seq == 0) post(w, callScript(id, true, "", true, 1));   // empty body
        }

        /**
         * The end index of the chunk that starts at {@code off}: up to {@code limit}
         * characters, minus one when the last of them is the high half of a surrogate
         * pair. Each chunk is quoted and parsed in the page on its own, so a pair cut in
         * two would arrive as two replacement characters — an emoji, a flag or any non-BMP
         * character in an alias or a client version used to be corrupted whenever it fell
         * on a 32 K boundary. The pair moves whole into the next chunk.
         */
        static int chunkEnd(String body, int off, int limit) {
            int end = Math.min(body.length(), off + limit);
            if (end < body.length() && end - 1 > off && Character.isHighSurrogate(body.charAt(end - 1))) {
                end--;
            }
            return end;
        }

        /** Hands one finished script string to the UI thread, which runs it in the page. */
        private void post(final WebView w, final String script) {
            if (script == null) return;
            w.post(new Runnable() {
                @Override
                public void run() {
                    if (destroyed) return;
                    WebView v = web.get();
                    if (v == null) return;
                    try {
                        v.evaluateJavascript(script, null);
                    } catch (Exception ignored) {
                    }
                }
            });
        }

        /**
         * The one-line call into the page: {@code NPBridgeOnData(id, ok, chunk, fin, seq)}.
         * The chunk is quoted per call, so the quoted copy and the finished script are
         * bounded by {@link #MAX_CHUNK_CHARS} whatever the body length.
         */
        private static String callScript(String id, boolean ok, String chunk,
                                         boolean fin, int seq) {
            if (id == null) return null;
            if (chunk == null) return null;
            return "window.NPBridgeOnData&&window.NPBridgeOnData("
                    + jsStringLiteral(id) + ","
                    + (ok ? "true" : "false") + ","
                    + jsStringLiteral(chunk) + ","
                    + (fin ? "true" : "false") + ","
                    + seq + ")";
        }
    }
}
