package io.github.mobileaidev.aiappbridge.uia;

import org.json.JSONObject;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Iterator;
import java.util.List;

/** Session reclamation runs only while the runtime holds the exclusive root owner.lock. */
final class UiaJournal {
    static final int ACTION_CAPACITY = 256, SESSION_CAPACITY = 64;
    private static final String UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    private static final String HASH = "[0-9a-f]{64}";
    private final Path root, sessions, retired;

    UiaJournal(Path root) { this.root = root; sessions = root.resolve("sessions"); retired = root.resolve("retired"); }

    static void directory(Path path) throws Exception {
        Files.createDirectories(path, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        canonical(path, true);
        Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("rwx------"));
    }

    private static void canonical(Path path, boolean directory) throws Exception {
        if (!(directory ? Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS) : Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS))
                || !path.toRealPath().equals(path)) throw new Wire.Failure("uia_invalid_journal_path");
    }

    private static List<Path> children(Path path, int limit) throws Exception {
        canonical(path, true);
        List<Path> result = new ArrayList<>();
        try (DirectoryStream<Path> entries = Files.newDirectoryStream(path)) {
            for (Path entry : entries) {
                if (result.size() >= limit) throw new Wire.Failure("uia_journal_capacity_exhausted");
                result.add(entry);
            }
        }
        return result;
    }

    private static boolean exists(Path path) { return Files.exists(path, LinkOption.NOFOLLOW_LINKS); }

    // An interrupted constructor may leave an empty session, and an interrupted atomic
    // write may leave its .tmp file. Only the committed *.json files authorize completion.
    private static void layout(Path session) throws Exception {
        if (!session.getFileName().toString().matches(UUID)) throw new Wire.Failure("uia_invalid_session_record");
        for (Path item : children(session, 4)) {
            String name = item.getFileName().toString();
            if (name.equals("actions")) {
                for (Path file : children(item, ACTION_CAPACITY * 2)) {
                    if (!file.getFileName().toString().matches(HASH + "\\.json(?:\\." + UUID + "\\.tmp)?"))
                        throw new Wire.Failure("uia_invalid_action_record");
                    canonical(file, false);
                }
            } else {
                if (!name.matches("runtime\\.json(?:\\." + UUID + "\\.tmp)?")) throw new Wire.Failure("uia_invalid_session_record");
                canonical(item, false);
            }
        }
    }

    private static JSONObject descriptor(Path session) throws Exception {
        Path file = session.resolve("runtime.json");
        if (!exists(file)) return null;
        canonical(file, false);
        JSONObject value = new JSONObject(DurableFiles.read(file, 8192));
        Wire.keys(value, "schemaVersion", "bootId", "runtimeEpoch", "dexSha256", "apiLevel", "pid", "socketName", "token", "sessionPath", "running");
        String epoch = Wire.uuid(value, "runtimeEpoch");
        Wire.uuid(value, "bootId"); Wire.bool(value, "running");
        Wire.integer(value, "apiLevel", 33, Integer.MAX_VALUE); Wire.integer(value, "pid", 1, Integer.MAX_VALUE);
        if (!Wire.string(value, "schemaVersion").equals("aab.uia.runtime.v1") || !epoch.equals(session.getFileName().toString())
                || !Wire.string(value, "sessionPath").equals(session.toString())
                || !Wire.string(value, "socketName").equals("aab-uia-" + epoch)
                || !Wire.string(value, "dexSha256").matches(HASH) || !Wire.string(value, "token").matches(HASH))
            throw new Wire.Failure("uia_invalid_session_record");
        return value;
    }

    private static boolean same(Object left, Object right) throws Exception {
        if (!(left instanceof JSONObject) || !(right instanceof JSONObject)) return left.equals(right);
        JSONObject a = (JSONObject) left, b = (JSONObject) right;
        if (a.length() != b.length()) return false;
        Iterator<String> keys = a.keys();
        while (keys.hasNext()) { String key = keys.next(); if (!b.has(key) || !same(a.get(key), b.get(key))) return false; }
        return true;
    }

    private static void binding(JSONObject value, JSONObject request) throws Exception {
        Wire.keys(value, "snapshotId", "ref", "selector", "clickPolicy", "target", "actionTarget", "window", "identityStrength");
        JSONObject selected = request.getJSONObject("target");
        for (String key : new String[]{"snapshotId", "ref", "selector"})
            if (!same(value.get(key), selected.get(key))) throw new Wire.Failure("uia_completion_identity_mismatch");
        if (!same(value.get("clickPolicy"), request.get("clickPolicy"))
                || !Wire.string(value, "identityStrength").equals("same_connection_node_and_reobserved_attributes"))
            throw new Wire.Failure("uia_completion_identity_mismatch");
        JSONObject window = Wire.object(value, "window"), target = Wire.object(value, "target"), action = Wire.object(value, "actionTarget");
        long windowId = Wire.integer(window, "id", 0, Integer.MAX_VALUE);
        if (Wire.integer(window, "displayId", 0, Integer.MAX_VALUE) != 0 || !Wire.bool(window, "focused"))
            throw new Wire.Failure("uia_invalid_completion_record");
        for (JSONObject node : new JSONObject[]{target, action}) {
            if (Wire.integer(node, "windowId", 0, Integer.MAX_VALUE) != windowId || !Wire.string(node, "sourceId").matches("-?[0-9]{1,20}")
                    || !Wire.bool(node, "enabled") || !Wire.bool(node, "visible")) throw new Wire.Failure("uia_invalid_completion_record");
        }
        JSONObject selector = selected.getJSONObject("selector");
        String actual = Wire.string(target, selector.getString("kind")), expected = selector.getString("value");
        if (!(selector.getBoolean("exact") ? actual.equals(expected) : actual.contains(expected))
                || !selector.isNull("packageName") && !same(selector.get("packageName"), target.get("packageName"))
                || !Wire.bool(action, "clickable")
                || (request.getString("clickPolicy").equals("exact_node") || Wire.bool(target, "clickable")) && !same(target, action))
            throw new Wire.Failure("uia_completion_identity_mismatch");
    }

    private static JSONObject actionRecord(Path file, JSONObject peer, String raw) throws Exception {
        JSONObject record = new JSONObject(raw);
        Wire.keys(record, "schemaVersion", "bootId", "runtimeEpoch", "actionId", "requestJson", "requestSha256", "preparedAtElapsedMs",
            "deadlineElapsedMs", "phase", "interactionId", "receiptJson", "receiptSha256", "acknowledged");
        if (!Wire.RECORD.equals(Wire.string(record, "schemaVersion")) || peer == null
                || !Wire.uuid(record, "bootId").equals(peer.getString("bootId"))
                || !Wire.uuid(record, "runtimeEpoch").equals(peer.getString("runtimeEpoch"))
                || !file.getFileName().toString().equals(Wire.sha256(Wire.actionId(record)) + ".json"))
            throw new Wire.Failure("uia_invalid_action_record");
        JSONObject request = Wire.request(Wire.string(record, "requestJson"), Wire.string(record, "requestSha256"),
            peer.getString("bootId"), peer.getString("runtimeEpoch"));
        if (!Wire.actionId(record).equals(Wire.actionId(request))) throw new Wire.Failure("uia_action_identity_conflict");
        long prepared = Wire.integer(record, "preparedAtElapsedMs", 0, Long.MAX_VALUE - 60000);
        if (Wire.integer(record, "deadlineElapsedMs", prepared, Long.MAX_VALUE) != prepared + request.getLong("timeoutMs"))
            throw new Wire.Failure("uia_invalid_action_record");
        Wire.integer(record, "interactionId", 0, Integer.MAX_VALUE);
        Wire.bool(record, "acknowledged");
        return record;
    }

    private static JSONObject terminalRecord(Path file, JSONObject peer) throws Exception {
        return terminalRecord(actionRecord(file, peer, DurableFiles.read(file, 131072)), peer);
    }

    private static JSONObject terminalRecord(JSONObject record, JSONObject peer) throws Exception {
        if (!Wire.string(record, "phase").equals("terminal")) throw new Wire.Failure("uia_previous_action_unresolved");
        JSONObject request = new JSONObject(record.getString("requestJson"));
        long prepared = record.getLong("preparedAtElapsedMs");
        int interaction = record.getInt("interactionId");
        String raw = Wire.string(record, "receiptJson");
        if (raw.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 65536
                || !Wire.sha256(raw).equals(Wire.string(record, "receiptSha256"))) throw new Wire.Failure("uia_invalid_completion_record");
        JSONObject receipt = new JSONObject(raw);
        for (String key : new String[]{"bootId", "runtimeEpoch", "actionId", "requestSha256"})
            if (!Wire.string(record, key).equals(Wire.string(receipt, key))) throw new Wire.Failure("uia_completion_identity_mismatch");
        List<String> fields = new ArrayList<>(Arrays.asList("schemaVersion", "bootId", "runtimeEpoch", "actionId", "requestSha256",
            "settled", "ok", "dispatched", "ambiguous", "completion"));
        boolean ok = Wire.bool(receipt, "ok"), dispatched = Wire.bool(receipt, "dispatched");
        if (!ok) { fields.add("error"); Wire.string(receipt, "error"); }
        if (receipt.has("binding")) { fields.add("binding"); binding(Wire.object(receipt, "binding"), request); }
        if (!Wire.EXECUTION.equals(Wire.string(receipt, "schemaVersion")) || !Wire.bool(receipt, "settled") || Wire.bool(receipt, "ambiguous"))
            throw new Wire.Failure("uia_invalid_completion_record");
        String completion = Wire.string(receipt, "completion");
        if (completion.equals("recovered_before_admission")) {
            fields.add("recovery");
            JSONObject recovery = Wire.object(receipt, "recovery");
            Wire.keys(recovery, "authority", "bootId", "observedAtElapsedMs", "priorPhase", "priorRecordSha256",
                "preparedAtElapsedMs", "originalDexSha256", "recoveryDexSha256");
            String recoveryBoot = Wire.uuid(recovery, "bootId");
            long observed = Wire.integer(recovery, "observedAtElapsedMs", 0, Long.MAX_VALUE);
            if (ok || dispatched || interaction != 0 || receipt.has("binding")
                    || !receipt.getString("error").equals("uia_owner_exited_before_admission")
                    || !Wire.string(recovery, "authority").equals("exclusive_runtime_root_lock")
                    || !Arrays.asList("prepared", "queued").contains(Wire.string(recovery, "priorPhase"))
                    || !Wire.string(recovery, "priorRecordSha256").matches(HASH)
                    || !Wire.string(recovery, "recoveryDexSha256").matches(HASH)
                    || !Wire.string(recovery, "originalDexSha256").equals(peer.getString("dexSha256"))
                    || Wire.integer(recovery, "preparedAtElapsedMs", 0, Long.MAX_VALUE) != prepared
                    || recoveryBoot.equals(record.getString("bootId")) && observed < prepared)
                throw new Wire.Failure("uia_invalid_completion_record");
            Wire.keys(receipt, fields.toArray(new String[0]));
            return record;
        }
        fields.add("completedAtElapsedMs");
        Wire.integer(receipt, "completedAtElapsedMs", prepared, Long.MAX_VALUE);
        if (completion.equals("original_callback")) {
            fields.add("callback"); JSONObject callback = Wire.object(receipt, "callback"); Wire.keys(callback, "interactionId", "handled");
            if (!dispatched || interaction < 1 || !receipt.has("binding")
                    || Wire.integer(callback, "interactionId", 1, Integer.MAX_VALUE) != interaction || Wire.bool(callback, "handled") != ok)
                throw new Wire.Failure("uia_invalid_completion_record");
        } else if (ok || dispatched || !completion.equals("before_admission") && !completion.equals("admission_rejected")
                || completion.equals("admission_rejected") && (interaction < 1 || !receipt.has("binding"))) {
            throw new Wire.Failure("uia_invalid_completion_record");
        }
        Wire.keys(receipt, fields.toArray(new String[0]));
        return record;
    }

    // One-shot maintenance holds owner.lock for the entire read/validate/write.
    // The engine must fsync "admitted" BEFORE Binder dispatch. Only a committed
    // prepared/queued record can therefore prove that this dead owner did not dispatch.
    JSONObject recover(JSONObject identity, String recoveryBoot, long observed, String recoveryDexHash) throws Exception {
        Wire.keys(identity, "bootId", "runtimeEpoch", "actionSha256", "requestSha256", "originalDexSha256");
        String epoch = Wire.uuid(identity, "runtimeEpoch"); Wire.uuid(identity, "bootId");
        for (String key : new String[]{"actionSha256", "requestSha256", "originalDexSha256"})
            if (!Wire.string(identity, key).matches(HASH)) throw new Wire.Failure("uia_completion_identity_mismatch");
        canonical(root, true);
        Path session = sessions.resolve(epoch);
        if (!exists(session)) throw new Wire.Failure("uia_original_action_record_not_retained");
        canonical(sessions, true); canonical(session, true);
        JSONObject peer = descriptor(session);
        if (peer == null || !peer.getString("bootId").equals(identity.getString("bootId"))
                || !peer.getString("dexSha256").equals(identity.getString("originalDexSha256")))
            throw new Wire.Failure("uia_completion_identity_mismatch");
        Path actions = session.resolve("actions"); canonical(actions, true);
        Path file = actions.resolve(identity.getString("actionSha256") + ".json");
        if (!exists(file)) throw new Wire.Failure("uia_original_action_record_not_retained");
        canonical(file, false);
        String prior = DurableFiles.read(file, 131072);
        JSONObject record = actionRecord(file, peer, prior);
        if (!record.getString("requestSha256").equals(identity.getString("requestSha256")))
            throw new Wire.Failure("uia_completion_identity_mismatch");
        String phase = Wire.string(record, "phase");
        if (!phase.equals("terminal")) {
            if (!phase.equals("prepared") && !phase.equals("queued")) throw new Wire.Failure("uia_previous_action_unresolved");
            if (record.getInt("interactionId") != 0 || record.getBoolean("acknowledged")
                    || !record.isNull("receiptJson") || !record.isNull("receiptSha256"))
                throw new Wire.Failure("uia_invalid_action_record");
            JSONObject receipt = new JSONObject().put("schemaVersion", Wire.EXECUTION).put("bootId", record.get("bootId"))
                .put("runtimeEpoch", epoch).put("actionId", record.get("actionId")).put("requestSha256", record.get("requestSha256"))
                .put("settled", true).put("ok", false).put("dispatched", false).put("ambiguous", false)
                .put("completion", "recovered_before_admission").put("error", "uia_owner_exited_before_admission")
                .put("recovery", new JSONObject().put("authority", "exclusive_runtime_root_lock").put("bootId", recoveryBoot)
                    .put("observedAtElapsedMs", observed).put("priorPhase", phase).put("priorRecordSha256", Wire.sha256(prior))
                    .put("preparedAtElapsedMs", record.get("preparedAtElapsedMs"))
                    .put("originalDexSha256", peer.get("dexSha256")).put("recoveryDexSha256", recoveryDexHash));
            String raw = receipt.toString();
            record.put("phase", "terminal").put("receiptJson", raw).put("receiptSha256", Wire.sha256(raw));
        }
        terminalRecord(record, peer);
        // Also resync on retry after a possible rename-before-directory-fsync failure.
        // Preserve the first receipt, including its recovery clock, byte for byte.
        DurableFiles.write(file, record.toString());
        return record;
    }

    // Called under owner.lock, either by a one-shot maintenance process or by
    // the current runtime for an older epoch. Never write behind an active engine.
    JSONObject acknowledge(JSONObject identity, String activeEpoch) throws Exception {
        Wire.keys(identity, "bootId", "runtimeEpoch", "actionSha256", "requestSha256", "receiptSha256", "originalDexSha256");
        String epoch = Wire.uuid(identity, "runtimeEpoch"); Wire.uuid(identity, "bootId");
        for (String key : new String[]{"actionSha256", "requestSha256", "receiptSha256", "originalDexSha256"})
            if (!Wire.string(identity, key).matches(HASH)) throw new Wire.Failure("uia_completion_identity_mismatch");
        if (epoch.equals(activeEpoch)) throw new Wire.Failure("uia_active_session_requires_engine");
        canonical(root, true);
        String disposition = "not_retained";
        if (exists(sessions)) {
            canonical(sessions, true);
            Path session = sessions.resolve(epoch);
            if (exists(session)) {
                canonical(session, true);
                JSONObject peer = descriptor(session);
                if (peer == null || !peer.getString("bootId").equals(identity.getString("bootId"))
                        || !peer.getString("dexSha256").equals(identity.getString("originalDexSha256")))
                    throw new Wire.Failure("uia_completion_identity_mismatch");
                Path actions = session.resolve("actions"); canonical(actions, true);
                Path file = actions.resolve(identity.getString("actionSha256") + ".json");
                if (exists(file)) {
                    canonical(file, false);
                    JSONObject record = terminalRecord(file, peer);
                    for (String key : new String[]{"requestSha256", "receiptSha256"})
                        if (!record.getString(key).equals(identity.getString(key))) throw new Wire.Failure("uia_completion_identity_mismatch");
                    // Repeat the durable write even on retry: a previous rename
                    // may have succeeded before its directory fsync failed.
                    DurableFiles.write(file, record.put("acknowledged", true).toString());
                    disposition = "acknowledged";
                }
            }
        }
        // Absence is cleanup state only. This response contains no action result
        // and cannot serve as a completion credential or release unknown ownership.
        return new JSONObject().put("ok", true).put("schemaVersion", "aab.uia.ack.v1")
            .put("identity", identity).put("disposition", disposition);
    }

    private static boolean disposable(Path session) throws Exception {
        layout(session);
        JSONObject peer = descriptor(session);
        Path actions = session.resolve("actions");
        if (!exists(actions)) {
            if (peer != null) throw new Wire.Failure("uia_invalid_session_record");
            return true;
        }
        boolean allAcknowledged = true;
        int count = 0;
        for (Path file : children(actions, ACTION_CAPACITY * 2)) {
            if (!file.getFileName().toString().endsWith(".json")) continue;
            if (++count > ACTION_CAPACITY) throw new Wire.Failure("uia_action_capacity_exhausted");
            if (!terminalRecord(file, peer).getBoolean("acknowledged")) allAcknowledged = false;
        }
        return allAcknowledged;
    }

    private void eraseRetired(Path session) throws Exception {
        layout(session);
        Path actions = session.resolve("actions");
        if (exists(actions)) {
            for (Path file : children(actions, ACTION_CAPACITY * 2)) Files.delete(file);
            DurableFiles.syncDirectory(actions); Files.delete(actions);
        }
        for (Path file : children(session, 4)) Files.delete(file);
        DurableFiles.syncDirectory(session); Files.delete(session); DurableFiles.syncDirectory(retired);
    }

    void prepare(String currentDexHash) throws Exception {
        directory(sessions); directory(retired); DurableFiles.syncDirectory(root);
        List<Path> reclaim = new ArrayList<>();
        int retained = 0;
        // Audit EVERY original session before moving or deleting any of them.
        for (Path session : children(sessions, SESSION_CAPACITY)) {
            if (disposable(session)) reclaim.add(session); else retained++;
        }
        if (retained >= SESSION_CAPACITY) throw new Wire.Failure("uia_session_capacity_exhausted");
        List<Path> interrupted = children(retired, SESSION_CAPACITY);
        for (Path session : interrupted) layout(session);
        // A durable rename into retired/ is the disposal commitment. Sync both
        // parents before deleting bytes, including when resuming after a crash.
        DurableFiles.syncDirectory(sessions); DurableFiles.syncDirectory(retired);
        for (Path session : interrupted) eraseRetired(session);
        for (Path session : reclaim) {
            Path destination = retired.resolve(session.getFileName());
            Files.move(session, destination, StandardCopyOption.ATOMIC_MOVE);
            DurableFiles.syncDirectory(sessions); DurableFiles.syncDirectory(retired);
            eraseRetired(destination);
        }
        // Only protocol-owned artifacts are eligible. Original unacknowledged
        // receipt files stay in sessions/ and do not need an old executable.
        for (Path file : children(root, 256)) {
            String name = file.getFileName().toString();
            if (name.matches("runtime-" + HASH + "\\.jar") && !name.equals("runtime-" + currentDexHash + ".jar")
                    || name.matches("runtime-" + HASH + "\\." + UUID + "\\.tmp")
                    || name.matches("runtime\\.json\\." + UUID + "\\.tmp")) {
                canonical(file, false); Files.delete(file);
            }
        }
        DurableFiles.syncDirectory(root);
    }
}
