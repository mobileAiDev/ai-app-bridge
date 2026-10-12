package io.github.mobileaidev.aiappbridge.uia;

import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class UiaNodeIdentityTest {
    private JSONObject node() throws Exception {
        return new JSONObject().put("sourceId", "123").put("windowId", 7).put("packageName", "app.test")
            .put("className", "android.widget.Button").put("resourceName", "app.test:id/agree")
            .put("text", "Agree").put("bounds", "[0,0][100,40]").put("checked", false);
    }
    @Test public void attributeChangesDoNotReplaceTheReferencedNode() throws Exception {
        assertTrue(UiaNodeIdentity.sameNode(node(), node().put("text", "Agree (1)")
            .put("bounds", "[0,1][100,41]").put("checked", true)));
    }
    @Test public void anotherNodeWindowOrPackageMustNotBeSubstituted() throws Exception {
        for (String key : new String[]{"sourceId", "windowId", "packageName", "className", "resourceName"})
            assertFalse(key, UiaNodeIdentity.sameNode(node(), node().put(key, "different")));
    }
}
