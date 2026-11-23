# Hardening the Android shell: `WebViewAssetLoader` + `WebMessageListener`

NodePulse ships one HTML file inside the APK. The shell that shows it is deliberately
small, and what it does today is described in the README ("Locked down shell", "Native HTTP
bridge"). This note records the part that is *not* done yet, why it is worth doing, and what
the migration would change — so the next round can take it up without re-deriving it.

## What the shell is now

* `MainActivity` (`android/app/src/main/java/com/corejbh/nodepulse/MainActivity.java`)
  extends `ComponentActivity` and holds one `WebView`.
* The page is loaded from `file:///android_asset/index.html`. Every navigation away from
  that exact URL is refused by `shouldOverrideUrlLoading`, file and content access are off,
  and a TLS error cancels the load.
* Two JavaScript interfaces are registered on the WebView:

  | Interface | Direction | Purpose |
  | --- | --- | --- |
  | `NPBridge.fetch(id, url)` | page → shell | one HTTPS GET for a host on the allowlist, because `bitnodes.io` sends no `Access-Control-Allow-Origin` |
  | `NPBack.setDepth(n)` | page → shell | how many of the page's own layers (card, panel) are open, so the back gesture closes them first |

* An answer comes back with `webView.evaluateJavascript("window.NPBridgeOnData(…)", null)`,
  in 32 K-character chunks that the page joins by sequence number.
* `HttpBridge` validates the request id's shape, the URL (https, no credentials, port -1 or
  443, host on a four-name allowlist), every redirect hop, and — since 1.1.12 — every address
  the host resolves to (loopback, link-local, private, CGNAT, multicast, unspecified and
  IPv6 unique-local addresses are refused).

That is a small surface, and it is checked twice. Its remaining costs are structural, not
live bugs:

1. **`file://` is an opaque origin.** A page loaded from `file:` gets no CORS relaxation at
   all, which is why the L1 layer needs the bridge in the first place — and why the very same
   page in a desktop browser can never read `bitnodes.io` and must fall back to its snapshot.
2. **`addJavascriptInterface` is a global back door.** Any frame in the WebView would reach
   `NPBridge`; the allowlist is what makes that acceptable, not the mechanism. There is also
   no origin scoping: the interface exists for whatever document is loaded.
3. **`evaluateJavascript` is string injection by construction.** The chunking and the id
   shape keep every script string bounded and well-formed, but the reply is still a string
   built on a native thread and executed in a global scope.

## The migration

### 1. Serve the page from a real https origin

`androidx.webkit:webkit`'s `WebViewAssetLoader` serves `assets/` from a synthetic https
origin instead of `file://`:

```java
WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
        .setDomain("appassets.androidplatform.net")
        .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
        .build();

webView.setWebViewClient(new AppClient(loader));   // shouldInterceptRequest -> loader.shouldInterceptRequest(url)
webView.loadUrl("https://appassets.androidplatform.net/assets/index.html");
```

`shouldOverrideUrlLoading` then allows exactly that one origin and path, and everything else
is still refused. The page keeps its own Content-Security-Policy; only `connect-src` matters
and it does not change.

What this buys:

* The page is an ordinary secure origin. `mempool.space` answers with
  `Access-Control-Allow-Origin: *`, so those reads work without the bridge; `bitnodes.io`
  still does not, so the bridge stays — but it is now one host's problem, not the origin's.
* `window.isSecureContext` is true, and WebCrypto/localStorage behaviour stops depending on
  a file-origin special case.
* The published web build and the APK run under the same origin rules, so a fault seen in
  one is reproducible in the other.

### 2. Talk to the page through a port, not a global function

`WebViewCompat.addWebMessageListener` (`androidx.webkit`) replaces both directions:

```java
WebViewCompat.addWebMessageListener(webView, "NPBridge",
        Set.of("https://appassets.androidplatform.net"),
        (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
            // message.getData() -> request id + url; replyProxy.postMessage(json)
        });
```

and in the page:

```js
const port = new Promise(res => window.addEventListener('message', e => {
  if (e.data && e.data.type === 'NPBRIDGE_PORT') res(e.ports[0]);
}));
```

* The listener is bound to an origin set, so only the app's own document can reach it — a
  frame, an injected iframe or any other page cannot.
* Replies travel as messages (`postMessage`), so the chunked `evaluateJavascript` delivery
  and its string quoting disappear entirely; the body never becomes JavaScript source.
* The back signal moves onto the same channel (`{type:'back-depth', depth:n}`), leaving one
  interface instead of two.

### 3. What does not change

The host allowlist, the id shape, the redirect rule, the DNS/address guard, the body cap and
the bounded worker pool are policy, not transport; they move to the message handler
unchanged and keep their JVM tests (`HttpBridgePolicyTest`).

## Order and risk

1. Land `WebViewAssetLoader` first, with the bridge untouched. The page gains an https
   origin; `connect-src` already names the hosts it reads. Risk: a CSP or localStorage
   behaviour change tied to `file:` — the headless suite does not model origins, so this
   needs one manual pass on a device.
2. Move the two interfaces onto `WebMessageListener`, keeping the old `@JavascriptInterface`
   path behind a feature check for one release. `WebViewFeature.isFeatureSupported(
   WebViewFeature.WEB_MESSAGE_LISTENER)` reports whether the installed WebView can do it
   (WebView 88+); older devices keep the current path.
3. Remove the old path once the floor is known.

`androidx.webkit:webkit` is not a dependency today. `androidx.activity` is (added in 1.1.12
for `OnBackPressedCallback`), so the project already resolves AndroidX artifacts.
