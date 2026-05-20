package io.github.mobileaidev.aiappbridge.gradle;

import com.android.build.api.instrumentation.AsmClassVisitorFactory;
import com.android.build.api.instrumentation.ClassContext;
import com.android.build.api.instrumentation.ClassData;
import com.android.build.api.instrumentation.InstrumentationParameters;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;

public abstract class OkHttpAutoCaptureClassVisitorFactory
        implements AsmClassVisitorFactory<InstrumentationParameters.None> {
    private static final String OKHTTP_BUILDER = "okhttp3/OkHttpClient$Builder";
    private static final String OKHTTP_BUILD_DESC = "()Lokhttp3/OkHttpClient;";
    private static final String HOOK_OWNER = "io/github/mobileaidev/aiappbridge/android/AiAppOkHttpAutoCapture";
    private static final String HOOK_NAME = "installBuilder";
    private static final String HOOK_DESC = "(Ljava/lang/Object;)Ljava/lang/Object;";

    @Override
    public ClassVisitor createClassVisitor(ClassContext classContext, ClassVisitor nextClassVisitor) {
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

    @Override
    public boolean isInstrumentable(ClassData classData) {
        String className = classData.getClassName();
        return !className.startsWith("io.github.mobileaidev.aiappbridge.android.")
                && !className.startsWith("io.github.mobileaidev.aiappbridge.gradle.")
                && !className.startsWith("okhttp3.")
                && !className.startsWith("okio.")
                && !className.startsWith("kotlin.")
                && !className.startsWith("kotlinx.");
    }
}

