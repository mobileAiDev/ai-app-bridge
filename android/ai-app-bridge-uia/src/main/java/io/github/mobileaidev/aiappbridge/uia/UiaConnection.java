package io.github.mobileaidev.aiappbridge.uia;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.os.Binder;
import android.os.Bundle;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.Parcel;
import android.os.RemoteException;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.List;

/** A single shell-owned accessibility connection. References expire with this connection. */
public final class UiaConnection implements AutoCloseable {
    private static final String CALLBACK =
        "android.view.accessibility.IAccessibilityInteractionConnectionCallback";

    public interface ActionCallback {
        void completed(boolean handled, int interactionId);
    }

    private final HandlerThread callbackThread;
    private final UiAutomation automation;
    private final Method disconnect;
    private final Method sourceId;
    private final Class<?> callbackType;
    private final int callbackTransaction;
    private final Object connection;
    private final Method performAction;

    /** The process entry point must prepare its main Looper before opening this connection. */
    public UiaConnection() throws Exception {
        if (Looper.getMainLooper() == null) throw new IllegalStateException("main_looper_required");

        // Resolve the exact platform protocol before any action can be admitted.
        // Unsupported framework APIs are an explicit runtime error, never a coordinate fallback.
        Class<?> connectionType = Class.forName("android.app.IUiAutomationConnection");
        Class<?> connectionImplementation = Class.forName("android.app.UiAutomationConnection");
        callbackType = Class.forName(CALLBACK);
        Field transaction = Class.forName(CALLBACK + "$Stub")
            .getDeclaredField("TRANSACTION_setPerformAccessibilityActionResult");
        transaction.setAccessible(true);
        callbackTransaction = transaction.getInt(null);
        sourceId = AccessibilityNodeInfo.class.getMethod("getSourceNodeId");
        disconnect = UiAutomation.class.getMethod("disconnect");
        Method connect = UiAutomation.class.getMethod("connect", int.class);
        Method connectionId = UiAutomation.class.getMethod("getConnectionId");
        Method getConnection = Class.forName("android.view.accessibility.AccessibilityInteractionClient")
            .getMethod("getConnection", int.class);
        performAction = Class.forName("android.accessibilityservice.IAccessibilityServiceConnection")
            .getMethod("performAccessibilityAction", int.class, long.class, int.class, Bundle.class,
                int.class, callbackType, long.class);

        callbackThread = new HandlerThread("AiAppBridgeUiaCallbacks");
        callbackThread.start();
        UiAutomation created = null;
        try {
            created = (UiAutomation) UiAutomation.class.getConstructor(Looper.class, connectionType)
                .newInstance(callbackThread.getLooper(), connectionImplementation.getConstructor().newInstance());
            connect.invoke(created, UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
            connection = getConnection.invoke(null, connectionId.invoke(created));
            if (connection == null) throw new IllegalStateException("uia_connection_unavailable");
            AccessibilityServiceInfo info = created.getServiceInfo();
            info.flags |= AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
                | AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
                | AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
            created.setServiceInfo(info);
            automation = created;
        } catch (Exception error) {
            if (created != null) {
                try { disconnect.invoke(created); }
                catch (Exception cleanup) { error.addSuppressed(cleanup); }
            }
            callbackThread.quitSafely();
            throw error;
        }
    }

    public void waitForIdle(long idleMs, long timeoutMs) throws Exception {
        automation.waitForIdle(idleMs, timeoutMs);
    }

    /** Clear the local window/node cache before querying the platform's current window inventory. */
    public List<AccessibilityWindowInfo> windows() {
        if (!automation.clearCache()) throw new IllegalStateException("uia_cache_clear_failed");
        return automation.getWindows();
    }

    public long sourceId(AccessibilityNodeInfo node) throws Exception {
        return (Long) sourceId.invoke(node);
    }

    /**
     * Submit once, preserving the platform's original asynchronous callback.
     * The returned boolean is admission only. The caller owns pending state until completed().
     * AccessibilityNodeInfo.performAction() cannot provide this distinction: its false result
     * also covers callback timeout and transport failure.
     */
    public boolean requestClick(int windowId, long nodeId, int interactionId,
            ActionCallback callback) throws Exception {
        Binder binder = new Binder() {
            @Override protected boolean onTransact(int code, Parcel data, Parcel reply, int flags)
                    throws RemoteException {
                if (code == IBinder.INTERFACE_TRANSACTION) {
                    reply.writeString(CALLBACK);
                    return true;
                }
                if (code != callbackTransaction) return false;
                data.enforceInterface(CALLBACK);
                boolean handled = data.readInt() != 0;
                int receivedId = data.readInt();
                if (receivedId != interactionId || data.dataAvail() != 0) {
                    throw new IllegalStateException("uia_callback_identity_mismatch");
                }
                callback.completed(handled, receivedId);
                return true;
            }
        };
        Object receiver = Proxy.newProxyInstance(callbackType.getClassLoader(),
            new Class<?>[]{callbackType}, (proxy, method, arguments) -> {
                if (method.getName().equals("asBinder")) return binder;
                throw new UnsupportedOperationException(method.getName());
            });
        return (Boolean) performAction.invoke(connection, windowId, nodeId,
            AccessibilityNodeInfo.ACTION_CLICK, null, interactionId, receiver, Thread.currentThread().getId());
    }

    /** The owning runtime must drain admitted actions before closing. */
    @Override public void close() throws Exception {
        try { disconnect.invoke(automation); }
        finally { callbackThread.quitSafely(); }
    }
}
