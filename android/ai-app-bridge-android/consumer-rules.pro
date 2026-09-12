-keep class io.github.mobileaidev.aiappbridge.android.AiAppBridgeInitProvider {
    public <init>();
}

-keep class io.github.mobileaidev.aiappbridge.android.AiAppBridge {
    public static final io.github.mobileaidev.aiappbridge.android.AiAppBridge INSTANCE;
    public static final void start(android.content.Context);
    public static final void setFlutterActionHandler(io.github.mobileaidev.aiappbridge.android.AiAppBridge$FlutterActionHandler);
    public static final boolean clearFlutterActionHandler(io.github.mobileaidev.aiappbridge.android.AiAppBridge$FlutterActionHandler);
    public static final java.lang.String checkFlutterAction(java.lang.String);
    public static final void updateFlutterSnapshot(java.lang.String);
    public static final void recordFlutterCapture(java.lang.String, java.lang.String);
}

-keep interface io.github.mobileaidev.aiappbridge.android.AiAppBridge$FlutterActionHandler { *; }
-keep interface io.github.mobileaidev.aiappbridge.android.AiAppBridge$FlutterActionReply { *; }
