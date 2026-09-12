package io.github.mobileaidev.aiappbridge.uia;

import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.UUID;

/** A receipt becomes public only after both the file and its directory entry are synced. */
final class DurableFiles {
    static void write(Path path, String value) throws Exception {
        Path temporary = path.resolveSibling(path.getFileName() + "." + UUID.randomUUID() + ".tmp");
        try {
            try (FileChannel file = FileChannel.open(temporary, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
                ByteBuffer bytes = ByteBuffer.wrap(value.getBytes(StandardCharsets.UTF_8));
                while (bytes.hasRemaining()) file.write(bytes);
                file.force(true);
            }
            Files.move(temporary, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            syncDirectory(path.getParent());
        } finally { Files.deleteIfExists(temporary); }
    }

    static void syncDirectory(Path path) throws Exception {
        try (FileChannel directory = FileChannel.open(path, StandardOpenOption.READ)) { directory.force(true); }
    }

    static String read(Path path, int maxBytes) throws Exception {
        if (Files.size(path) > maxBytes) throw new Wire.Failure("uia_record_too_large");
        byte[] bytes = Files.readAllBytes(path);
        if (bytes.length > maxBytes) throw new Wire.Failure("uia_record_too_large");
        return StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString();
    }
}
