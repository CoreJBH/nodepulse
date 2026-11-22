# Release build is minified (R8). The only Java is the WebView shell, so the rules
# exist to keep the one surface the page actually calls: the @JavascriptInterface
# methods of NPBridge and the class that owns them.

-keepattributes RuntimeVisibleAnnotations,AnnotationDefault

-keep class com.jbitmstr.nodepulse.MainActivity { *; }
-keep class com.jbitmstr.nodepulse.MainActivity$HttpBridge { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# WebView and JSONObject are platform classes; nothing to warn about.
-dontwarn android.webkit.**
-dontwarn org.json.**
