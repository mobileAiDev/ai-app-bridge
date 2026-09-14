package io.github.mobileaidev.aiappbridge.uia;

import java.nio.ByteBuffer;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/** Exact POSIX durability, without java.nio.file (unavailable before Android API 26). */
final class DurableFiles {
    interface Posix {
        boolean exists(File file) throws Exception;
        void chmod(File file, int mode) throws Exception;
        void rename(File source, File destination) throws Exception;
        void syncDirectory(File directory) throws Exception;
    }

    private final Posix posix;
    DurableFiles(Posix posix) { this.posix = posix; }
    boolean exists(File file) throws Exception { return posix.exists(file); }

    void directory(File path) throws Exception {
        if (!path.isDirectory() && !path.mkdirs()) throw new IOException("Cannot create journal directory: " + path);
        canonical(path, true);
        posix.chmod(path, 0700);
    }

    static void canonical(File path, boolean directory) throws Exception {
        if (!(directory ? path.isDirectory() : path.isFile()) || !path.getCanonicalFile().equals(path))
            throw new Wire.Failure("uia_invalid_journal_path");
    }

    void write(File path, String value) throws Exception {
        File temporary = new File(path.getParentFile(), path.getName() + "." + UUID.randomUUID() + ".tmp");
        if (!temporary.createNewFile()) throw new IOException("Journal temporary file already exists");
        try {
            try (FileOutputStream file = new FileOutputStream(temporary)) {
                file.write(value.getBytes(StandardCharsets.UTF_8));
                file.getFD().sync();
            }
            move(temporary, path);
            syncDirectory(path.getParentFile());
        } finally { if (exists(temporary)) delete(temporary); }
    }

    void move(File source, File destination) throws Exception { posix.rename(source, destination); }
    void syncDirectory(File directory) throws Exception { posix.syncDirectory(directory); }
    static void delete(File path) throws IOException {
        if (!path.delete()) throw new IOException("Cannot delete journal path: " + path);
    }

    static byte[] readBytes(File path, int maxBytes) throws Exception {
        if (path.length() > maxBytes) throw new Wire.Failure("uia_record_too_large");
        try (FileInputStream input = new FileInputStream(path); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (output.size() + count > maxBytes) throw new Wire.Failure("uia_record_too_large");
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }

    static String read(File path, int maxBytes) throws Exception {
        return StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(readBytes(path, maxBytes))).toString();
    }
}
