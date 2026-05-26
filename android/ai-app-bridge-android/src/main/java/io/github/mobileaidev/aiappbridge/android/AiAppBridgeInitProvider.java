package io.github.mobileaidev.aiappbridge.android;

import android.app.Application;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Process;
import android.util.Log;
import android.webkit.WebView;

import java.io.FileInputStream;
import java.io.IOException;

public final class AiAppBridgeInitProvider extends ContentProvider {
    @Override
    public boolean onCreate() {
        Context context = getContext();
        if (context == null || context.getApplicationContext() == null) {
            return true;
        }

        Context appContext = context.getApplicationContext();
        boolean debuggable =
                (appContext.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (debuggable) {
            enableWebViewDebugging();
        }
        if (debuggable && isMainProcess(appContext)) {
            startBridgeReflectively(appContext);
        }
        return true;
    }

    private static void enableWebViewDebugging() {
        try {
            WebView.setWebContentsDebuggingEnabled(true);
        } catch (Throwable ignored) {
            // Some OEM WebView implementations can throw before WebView is ready.
        }
    }

    private static void startBridgeReflectively(Context context) {
        try {
            Class<?> bridgeClass =
                    Class.forName("io.github.mobileaidev.aiappbridge.android.AiAppBridge");
            Object bridgeInstance = bridgeClass.getField("INSTANCE").get(null);
            bridgeClass.getMethod("start", Context.class).invoke(bridgeInstance, context);
        } catch (Throwable error) {
            Log.w("AiAppBridge", "Failed to start bridge from init provider.", error);
        }
    }

    private static boolean isMainProcess(Context context) {
        int pid = Process.myPid();
        String processName = null;
        try {
            if (Build.VERSION.SDK_INT >= 28) {
                processName = Application.getProcessName();
            } else {
                processName = readProcessName(pid);
            }
        } catch (Throwable ignored) {
            processName = null;
        }
        return processName == null || processName.equals(context.getPackageName());
    }

    private static String readProcessName(int pid) throws IOException {
        FileInputStream input = new FileInputStream("/proc/" + pid + "/cmdline");
        try {
            byte[] buffer = new byte[256];
            int length = input.read(buffer);
            if (length <= 0) {
                return null;
            }
            int end = 0;
            while (end < length && buffer[end] != 0) {
                end++;
            }
            return new String(buffer, 0, end, "UTF-8").trim();
        } finally {
            input.close();
        }
    }

    @Override
    public Cursor query(
            Uri uri,
            String[] projection,
            String selection,
            String[] selectionArgs,
            String sortOrder
    ) {
        return null;
    }

    @Override
    public String getType(Uri uri) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
