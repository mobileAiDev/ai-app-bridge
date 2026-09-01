package io.github.mobileaidev.aiappbridge.android

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class H5ConsoleDrainParserTest {
    @Test
    fun parsesJsonArrayAndQuotedJsonString() {
        val array = H5ConsoleDrainParser.parse(
            """[{"method":"warn","message":"hello","atMs":10}]""",
        )
        val quoted = H5ConsoleDrainParser.parse(
            JSONObject.quote("""[{"method":"error","message":"boom","atMs":11}]"""),
        )

        assertEquals(1, array.size)
        assertEquals("warn", array[0].method)
        assertEquals("hello", array[0].message)
        assertEquals(10L, array[0].atMs)
        assertEquals(listOf("error"), quoted.map { it.method })
        assertEquals(emptyList<H5ConsoleLine>(), H5ConsoleDrainParser.parse("undefined"))
        assertEquals(emptyList<H5ConsoleLine>(), H5ConsoleDrainParser.parse("null"))
        assertEquals(emptyList<H5ConsoleLine>(), H5ConsoleDrainParser.parse(""))
        assertEquals(emptyList<H5ConsoleLine>(), H5ConsoleDrainParser.parse(null))
    }

    @Test
    fun malformedDrainDoesNotThrowAndSkipsNonObjects() {
        assertEquals(emptyList<H5ConsoleLine>(), H5ConsoleDrainParser.parse("not-json"))
        assertEquals(emptyList<H5ConsoleLine>(), H5ConsoleDrainParser.parse("123"))
        assertEquals(
            listOf("kept"),
            H5ConsoleDrainParser.parse("""[{"method":"log","message":"kept","atMs":1},"skip",null]""")
                .map { it.message },
        )
    }

    @Test
    fun drainH5PagesInstallsThenPersistsDrain() {
        val scripts = mutableListOf<String>()
        val persisted = mutableListOf<H5ConsoleLine>()
        val page = H5ConsolePage { script, callback ->
            scripts.add(script)
            if (script == H5ConsoleScripts.INSTALL) {
                callback("1")
            } else {
                callback("""[{"method":"debug","message":"from-h5","atMs":9}]""")
            }
        }

        drainH5Pages(listOf(page), persisted::add)

        assertEquals(listOf(H5ConsoleScripts.INSTALL, H5ConsoleScripts.DRAIN), scripts)
        assertEquals(1, persisted.size)
        assertEquals("debug", persisted[0].method)
        assertEquals("from-h5", persisted[0].message)
        assertEquals(9L, persisted[0].atMs)
    }
}
