package io.github.mobileaidev.aiappbridge.uia;

import java.io.File;
import java.util.UUID;
import org.json.JSONObject;

/** Called only under the original owner.lock, after killing the old executor. */
final class UiaReset {
    static boolean isUiaProcess(String[] argv, String mainClass) {
        if (argv.length == 0) return false;
        String executable = new File(argv[0]).getName();
        return argv[0].equals(mainClass) || ((executable.equals("app_process") || executable.equals("app_process64"))
            && java.util.Arrays.asList(argv).contains(mainClass));
    }

    static JSONObject archive(File root, DurableFiles files) throws Exception {
        File archives = new File(root, "force-stopped"); files.directory(archives);
        String resetId = UUID.randomUUID().toString();
        File archive = new File(archives, resetId); files.directory(archive);
        for (String name : new String[] { "sessions", "runtime.json" }) {
            File source = new File(root, name);
            if (source.exists() && !source.renameTo(new File(archive, name)))
                throw new java.io.IOException("Cannot archive forced-stop history: " + name);
        }
        // Keep owner.lock at the same inode. Old epochs cannot be reopened or
        // called back into the new session; original unknown records stay intact.
        JSONObject result = new JSONObject().put("ok", true).put("schemaVersion", "aab.uia.reset.v1")
            .put("stopped", true).put("resetId", resetId).put("archivePath", archive.toString())
            .put("outcome", "unknown");
        files.write(new File(archive, "reset.json"), result.toString());
        files.syncDirectory(archive); files.syncDirectory(archives); files.syncDirectory(root);
        return result;
    }
}
