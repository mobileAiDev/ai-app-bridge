package io.github.mobileaidev.aiappbridge.gradle;

import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;

final class OkHttpAutoCaptureClassVisitor {
    static final String OKHTTP_BUILDER = "okhttp3/OkHttpClient$Builder";
    static final String OKHTTP_BUILD_DESC = "()Lokhttp3/OkHttpClient;";
    static final String HOOK_OWNER = "io/github/mobileaidev/aiappbridge/android/AiAppOkHttpAutoCapture";
    static final String HOOK_NAME = "installBuilder";
    static final String HOOK_DESC = "(Ljava/lang/Object;)Ljava/lang/Object;";

    private OkHttpAutoCaptureClassVisitor() {
    }

    static ClassVisitor wrap(ClassVisitor nextClassVisitor) {
        return new ClassVisitor(Opcodes.ASM9, nextClassVisitor) {
            @Override
            public MethodVisitor visitMethod(
                    int access,
                    String name,
                    String descriptor,
                    String signature,
                    String[] exceptions
            ) {
                MethodVisitor next = super.visitMethod(access, name, descriptor, signature, exceptions);
                return new MethodVisitor(Opcodes.ASM9, next) {
                    @Override
                    public void visitMethodInsn(
                            int opcode,
                            String owner,
                            String methodName,
                            String methodDescriptor,
                            boolean isInterface
                    ) {
                        if (opcode == Opcodes.INVOKEVIRTUAL
                                && OKHTTP_BUILDER.equals(owner)
                                && "build".equals(methodName)
                                && OKHTTP_BUILD_DESC.equals(methodDescriptor)) {
                            super.visitMethodInsn(
                                    Opcodes.INVOKESTATIC,
                                    HOOK_OWNER,
                                    HOOK_NAME,
                                    HOOK_DESC,
                                    false
                            );
                            super.visitTypeInsn(Opcodes.CHECKCAST, OKHTTP_BUILDER);
                        }
                        super.visitMethodInsn(opcode, owner, methodName, methodDescriptor, isInterface);
                    }
                };
            }
        };
    }

    static boolean isInstrumentable(String className) {
        return !className.startsWith("io.github.mobileaidev.aiappbridge.android.")
                && !className.startsWith("io.github.mobileaidev.aiappbridge.gradle.")
                && !className.startsWith("okhttp3.")
                && !className.startsWith("okio.")
                && !className.startsWith("kotlin.")
                && !className.startsWith("kotlinx.");
    }

    static byte[] transform(byte[] input) {
        ClassReader reader = new ClassReader(input);
        String className = reader.getClassName().replace('/', '.');
        if (!isInstrumentable(className)) {
            return input;
        }
        ClassWriter writer = new ClassWriter(reader, ClassWriter.COMPUTE_MAXS);
        reader.accept(wrap(writer), 0);
        return writer.toByteArray();
    }
}
