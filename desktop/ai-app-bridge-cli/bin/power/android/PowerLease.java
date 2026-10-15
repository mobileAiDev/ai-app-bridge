package io.github.mobileaidev.aiappbridge.power;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import org.json.JSONObject;

/** One shell process owns one lease. No input injection, settings, or UI automation. */
public final class PowerLease {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final PowerManager manager;
    private final String leaseId;
    private final String mode;
    private PowerManager.WakeLock cpu;
    private PowerManager.WakeLock display;
    private boolean stopped;
    private long deadline;
    private final Runnable expiry = () -> {
        if (SystemClock.elapsedRealtime() >= deadline) finish(null, "expired");
        else handler.postDelayed(this.expiry, deadline - SystemClock.elapsedRealtime());
    };

    private PowerLease(Context context, String leaseId, String mode) {
        this.manager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        this.leaseId = leaseId;
        this.mode = mode;
    }

    private static int ttl(Object value) {
        if (!(value instanceof Integer) || (int) value < 1 || (int) value > 300000)
            throw new IllegalArgumentException("ttlMs must be an integer from 1 to 300000.");
        return (int) value;
    }

    private JSONObject coverage() throws Exception {
        return new JSONObject().put("mechanism", "shell-owned-PowerManager-WakeLock")
            .put("scope", "selected-device").put("system", !mode.equals("display"))
            .put("display", !mode.equals("system")).put("displayRequiresAlreadyAwake", true)
            .put("cpuWhileDisplayOff", !mode.equals("display")).put("cpuWhileDisplayOn", true)
            .put("interactive", manager.isInteractive()).put("settingsChanged", false)
            .put("manualSleep", "not_prevented").put("unlock", false)
            .put("pid", android.os.Process.myPid()).put("uid", android.os.Process.myUid());
    }

    private PowerManager.WakeLock lock(int level, String name) {
        if (!manager.isWakeLockLevelSupported(level)) throw new IllegalStateException("Wake lock level is not supported: " + level);
        PowerManager.WakeLock lock = manager.newWakeLock(level, "AiAppBridge:power:" + leaseId + ":" + name);
        lock.setReferenceCounted(false);
        return lock;
    }

    @SuppressWarnings("deprecation")
    private void acquire(int ttlMs) throws Exception {
        if (!mode.equals("display")) cpu = lock(PowerManager.PARTIAL_WAKE_LOCK, "cpu");
        // This shell-owned, expiring lock must apply to a selected external app.
        // FLAG_KEEP_SCREEN_ON would cover only a window in an SDK-owned app.
        if (!mode.equals("system")) display = lock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK, "display");
        renew(ttlMs);
        send(new JSONObject().put("type", "ready").put("ok", true).put("leaseId", leaseId).put("coverage", coverage()));
    }

    private void renew(int ttlMs) {
        // Timed acquisition bounds locks even if the Host or its pipe vanishes.
        if (cpu != null) cpu.acquire(ttlMs);
        if (display != null) display.acquire(ttlMs);
        deadline = SystemClock.elapsedRealtime() + ttlMs;
        handler.removeCallbacks(expiry);
        handler.postDelayed(expiry, ttlMs);
    }

    private void receive(String line) {
        if (stopped) return;
        String requestId = null;
        try {
            if (line.length() > 4096) throw new IllegalArgumentException("Power request exceeds its message limit.");
            JSONObject message = new JSONObject(line);
            requestId = message.getString("requestId");
            String operation = message.getString("operation");
            if (operation.equals("release")) { finish(requestId, "released"); return; }
            if (!operation.equals("renew")) throw new IllegalArgumentException("Unknown power operation.");
            if (SystemClock.elapsedRealtime() >= deadline) {
                send(new JSONObject().put("ok", false).put("error", "power_lease_ended")
                    .put("message", "The Android platform lease expired before renewal.").put("requestId", requestId));
                finish(null, "expired"); return;
            }
            renew(ttl(message.get("ttlMs")));
            send(new JSONObject().put("ok", true).put("requestId", requestId).put("coverage", coverage()));
        } catch (Exception error) {
            error(requestId, error);
            finish(null, "failed");
        }
    }

    private void finish(String requestId, String reason) {
        if (stopped) return;
        stopped = true;
        handler.removeCallbacks(expiry);
        try {
            if (cpu != null && cpu.isHeld()) cpu.release();
            if (display != null && display.isHeld()) display.release();
            send(new JSONObject().put("ok", true).put("type", "released").put("released", true)
                .put("reason", reason).put("requestId", requestId));
            System.exit(0);
        } catch (Exception error) { error(requestId, error); System.exit(2); }
    }

    private static synchronized void send(JSONObject value) throws Exception {
        value.put("protocol", "aab.power/v1");
        System.out.println(value.toString());
        System.out.flush();
    }

    private static void error(String requestId, Exception error) {
        try { send(new JSONObject().put("ok", false).put("error", "power_android_failed")
            .put("message", error.toString()).put("requestId", requestId)); }
        catch (Exception formatting) { System.err.println(formatting); }
    }

    public static void main(String[] args) {
        PowerLease worker = null;
        try {
            if (args.length != 3 || !args[0].matches("[0-9a-f-]{36}") || !args[1].matches("system|display|both"))
                throw new IllegalArgumentException("Invalid power worker arguments.");
            int ttlMs = ttl(Integer.valueOf(args[2]));
            Looper.prepareMainLooper();
            Class<?> activityThread = Class.forName("android.app.ActivityThread");
            Object thread = activityThread.getMethod("systemMain").invoke(null);
            Context system = (Context) activityThread.getMethod("getSystemContext").invoke(thread);
            Context shell = system.createPackageContext("com.android.shell", 0);
            worker = new PowerLease(shell, args[0], args[1]);
            worker.acquire(ttlMs);
            PowerLease owner = worker;
            Thread input = new Thread(() -> {
                try {
                    BufferedReader reader = new BufferedReader(new InputStreamReader(System.in, "UTF-8"));
                    String line;
                    while ((line = reader.readLine()) != null) {
                        String request = line;
                        owner.handler.post(() -> owner.receive(request));
                    }
                    owner.handler.post(() -> owner.finish(null, "input_closed"));
                } catch (Exception error) { owner.handler.post(() -> { error(null, error); owner.finish(null, "input_failed"); }); }
            }, "aab-power-input");
            input.setDaemon(true);
            input.start();
            Looper.loop();
        } catch (Exception error) {
            error(null, error);
            if (worker != null) worker.finish(null, "failed");
            System.exit(2);
        }
    }
}
