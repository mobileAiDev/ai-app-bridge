package io.github.mobileaidev.aiappbridge.gradle;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class AiAppBridgeExtensionTest {
    @Test
    public void exposesKotlinDslFriendlyBooleanGetters() {
        AiAppBridgeExtension extension = new AiAppBridgeExtension();

        assertTrue(extension.getEnabled());
        assertTrue(extension.getOkHttpCaptureEnabled());
        assertFalse(extension.getWebSocketCaptureEnabled());
        assertFalse(extension.getLogInstrumentationEnabled());
        assertTrue(extension.getWebViewDebuggingEnabled());
    }

    @Test
    public void settersUpdateBothGetterStyles() {
        AiAppBridgeExtension extension = new AiAppBridgeExtension();

        extension.setEnabled(false);
        extension.setOkHttpCaptureEnabled(false);
        extension.setWebSocketCaptureEnabled(true);
        extension.setLogInstrumentationEnabled(true);
        extension.setWebViewDebuggingEnabled(false);

        assertFalse(extension.isEnabled());
        assertFalse(extension.getEnabled());
        assertFalse(extension.isOkHttpCaptureEnabled());
        assertFalse(extension.getOkHttpCaptureEnabled());
        assertTrue(extension.isWebSocketCaptureEnabled());
        assertTrue(extension.getWebSocketCaptureEnabled());
        assertTrue(extension.isLogInstrumentationEnabled());
        assertTrue(extension.getLogInstrumentationEnabled());
        assertFalse(extension.isWebViewDebuggingEnabled());
        assertFalse(extension.getWebViewDebuggingEnabled());
    }
}
