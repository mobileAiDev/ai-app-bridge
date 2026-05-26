package io.github.mobileaidev.aiappbridge.gradle;

public class AiAppBridgeExtension {
    private boolean enabled = true;
    private boolean okHttpCaptureEnabled = true;
    private boolean webSocketCaptureEnabled = false;
    private boolean logInstrumentationEnabled = false;
    private boolean webViewDebuggingEnabled = true;
    private String runtimeDependencyNotation = "";

    public boolean isEnabled() {
        return enabled;
    }

    public boolean getEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public boolean isOkHttpCaptureEnabled() {
        return okHttpCaptureEnabled;
    }

    public boolean getOkHttpCaptureEnabled() {
        return okHttpCaptureEnabled;
    }

    public void setOkHttpCaptureEnabled(boolean okHttpCaptureEnabled) {
        this.okHttpCaptureEnabled = okHttpCaptureEnabled;
    }

    public boolean isWebSocketCaptureEnabled() {
        return webSocketCaptureEnabled;
    }

    public boolean getWebSocketCaptureEnabled() {
        return webSocketCaptureEnabled;
    }

    public void setWebSocketCaptureEnabled(boolean webSocketCaptureEnabled) {
        this.webSocketCaptureEnabled = webSocketCaptureEnabled;
    }

    public boolean isLogInstrumentationEnabled() {
        return logInstrumentationEnabled;
    }

    public boolean getLogInstrumentationEnabled() {
        return logInstrumentationEnabled;
    }

    public void setLogInstrumentationEnabled(boolean logInstrumentationEnabled) {
        this.logInstrumentationEnabled = logInstrumentationEnabled;
    }

    public boolean isWebViewDebuggingEnabled() {
        return webViewDebuggingEnabled;
    }

    public boolean getWebViewDebuggingEnabled() {
        return webViewDebuggingEnabled;
    }

    public void setWebViewDebuggingEnabled(boolean webViewDebuggingEnabled) {
        this.webViewDebuggingEnabled = webViewDebuggingEnabled;
    }

    public String getRuntimeDependencyNotation() {
        return runtimeDependencyNotation;
    }

    public void setRuntimeDependencyNotation(String runtimeDependencyNotation) {
        this.runtimeDependencyNotation = runtimeDependencyNotation == null ? "" : runtimeDependencyNotation;
    }
}

