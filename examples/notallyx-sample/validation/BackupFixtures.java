import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import net.lingala.zip4j.ZipFile;
import net.lingala.zip4j.exception.ZipException;
import net.lingala.zip4j.model.ZipParameters;
import net.lingala.zip4j.model.enums.EncryptionMethod;
import net.lingala.zip4j.model.enums.AesKeyStrength;

// Public test vector, never a user's password. Provisioning is not an App export claim.
class BackupFixtures {
    public static void main(String[] args) throws Exception {
        Path database = Path.of(args[0]), out = Path.of(args[1]);
        Files.createDirectory(out);
        ZipParameters parameters = new ZipParameters();
        parameters.setFileNameInZip("NotallyDatabase");
        parameters.setEncryptFiles(true);
        parameters.setEncryptionMethod(EncryptionMethod.AES);
        parameters.setAesKeyStrength(AesKeyStrength.KEY_STRENGTH_256);
        File encrypted = out.resolve("AAB-encrypted.zip").toFile();
        try (ZipFile zip = new ZipFile(encrypted, "AAB-test-42".toCharArray())) {
            zip.addFile(database.toFile(), parameters);
            var header = zip.getFileHeaders().get(0);
            if (zip.getFileHeaders().size() != 1 || !header.isEncrypted()
                || header.getEncryptionMethod() != EncryptionMethod.AES) throw new Exception("AES fixture required");
            if (!java.util.Arrays.equals(zip.getInputStream(header).readAllBytes(), Files.readAllBytes(database)))
                throw new Exception("encrypted fixture bytes differ");
        }
        boolean rejected = false;
        try (ZipFile zip = new ZipFile(encrypted, "AAB-wrong-42".toCharArray())) {
            zip.getInputStream(zip.getFileHeaders().get(0)).readAllBytes();
        } catch (ZipException error) { rejected = error.getType() == ZipException.Type.WRONG_PASSWORD; }
        if (!rejected) throw new Exception("wrong password was not rejected by fixture decoder");
        Files.writeString(out.resolve("AAB-corrupt.zip"), "AAB intentionally invalid ZIP test vector\n");
        Path marker = out.resolve("README.txt"); Files.writeString(marker, "Archive deliberately has no NotallyDatabase.\n");
        try (ZipFile zip = new ZipFile(out.resolve("AAB-missing-db.zip").toFile())) { zip.addFile(marker.toFile()); }
        Files.delete(marker);
        System.out.println("{\"ok\":true,\"encrypted\":\"AES-256\",\"correctPasswordBytesVerified\":true,\"wrongPasswordRejected\":true}");
    }
}
