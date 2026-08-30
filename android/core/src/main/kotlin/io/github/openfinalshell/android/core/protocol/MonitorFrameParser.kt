package io.github.openfinalshell.android.core.protocol

/** Parser for the line-oriented @@OFS monitor frames emitted by the existing desktop client. */
object MonitorFrameParser {
    private val sectionPattern = Regex("^@@OFS:([A-Z]+)@@$")

    fun splitSections(frameBody: String): Map<String, String> {
        val result = linkedMapOf<String, String>()
        var current: String? = null
        val lines = mutableListOf<String>()
        frameBody.lineSequence().forEach { raw ->
            val line = raw.trim()
            val match = sectionPattern.matchEntire(line)
            if (match != null) {
                current?.let { result[it] = lines.joinToString("\n") }
                current = match.groupValues[1]
                lines.clear()
            } else if (current != null) {
                lines += raw
            }
        }
        current?.let { result[it] = lines.joinToString("\n") }
        return result
    }

    fun extractFrame(buffer: String, sequence: Long): String? {
        val begin = "@@OFS:BEGIN:${sequence}@@"
        val end = "@@OFS:END:${sequence}@@"
        val start = buffer.indexOf(begin)
        if (start < 0) return null
        val bodyStart = start + begin.length
        val endIndex = buffer.indexOf(end, bodyStart)
        if (endIndex < 0) return null
        return buffer.substring(bodyStart, endIndex).trim('\r', '\n')
    }
}
