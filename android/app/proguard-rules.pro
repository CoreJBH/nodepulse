# Release build is minified (R8). The only Java is the WebView shell, so the rules
# exist to keep the two surfaces the page actually calls: the @JavascriptInterface
# methods of NPBridge and NPBack, and the classes that own them.

-keepattributes RuntimeVisibleAnnotations,AnnotationDefault

-keep class com.corejbh.nodepulse.MainActivity { *; }
-keep class com.corejbh.nodepulse.MainActivity$HttpBridge { *; }
-keep class com.corejbh.nodepulse.MainActivity$BackSignal { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# WebView and JSONObject are platform classes; nothing to warn about.
-dontwarn android.webkit.**
-dontwarn org.json.**
