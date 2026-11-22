package com.jbitmstr.nodepulse;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;

import org.junit.Test;

/**
 * The chunk boundaries {@link MainActivity.HttpBridge} hands a body over with.
 *
 * <p>Each chunk becomes its own JavaScript string literal, which the page parses on its
 * own, so a surrogate pair cut across two chunks arrives as two replacement characters.
 * The boundary rule under test moves such a pair whole into the next chunk, and the walk
 * that follows it must neither repeat nor skip a character.
 */
public class HttpBridgeChunkTest {

    private static final String EMOJI = "\uD83D\uDE00";          // 😀, two chars
    private static final String FLAG = "\uD83C\uDDF0\uD83C\uDDF7"; // 🇰🇷, two pairs

    /** Walks a body exactly the way deliver() does and returns the chunks it would send. */
    private static List<String> chunks(String body, int limit) {
        List<String> out = new ArrayList<>();
        int off = 0;
        while (off < body.length()) {
            int end = MainActivity.HttpBridge.chunkEnd(body, off, limit);
            assertTrue("a chunk must make progress at " + off + " with limit " + limit, end > off);
            assertTrue("a chunk must not run past the body", end <= body.length());
            out.add(body.substring(off, end));
            off = end;
        }
        return out;
    }

    private static String join(List<String> parts) {
        StringBuilder sb = new StringBuilder();
        for (String p : parts) sb.append(p);
        return sb.toString();
    }

    @Test
    public void asciiIsCutAtTheLimit() {
        List<String> c = chunks("abcdefghij", 4);
        assertEquals(3, c.size());
        assertEquals("abcd", c.get(0));
        assertEquals("efgh", c.get(1));
        assertEquals("ij", c.get(2));
    }

    @Test
    public void aPairOnTheBoundaryMovesWholeIntoTheNextChunk() {
        String body = "abc" + EMOJI + "def";          // the emoji sits at index 3-4
        List<String> c = chunks(body, 4);
        assertEquals("abc", c.get(0));
        assertEquals(EMOJI + "de", c.get(1));
        assertEquals("f", c.get(2));
        assertEquals(body, join(c));
    }

    @Test
    public void noChunkEndsInALoneHighSurrogateOrStartsWithALowOne() {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 40; i++) {
            sb.append('a');
            if (i % 3 == 0) sb.append(EMOJI);
            if (i % 7 == 0) sb.append(FLAG);
        }
        String body = sb.toString();
        /* A limit of one character cannot keep a pair together, so the rule is checked
           from two up; deliver() uses 32768. */
        for (int limit = 2; limit <= 9; limit++) {
            List<String> c = chunks(body, limit);
            for (int i = 0; i < c.size(); i++) {
                String part = c.get(i);
                assertFalse("chunk " + i + " starts with a lone low surrogate (limit " + limit + ")",
                        Character.isLowSurrogate(part.charAt(0)));
                if (Character.isHighSurrogate(part.charAt(part.length() - 1))) {
                    assertTrue("chunk " + i + " ends in a lone high surrogate (limit " + limit + ")",
                            i == c.size() - 1);
                }
            }
            assertEquals("the chunks must join back into the body (limit " + limit + ")", body, join(c));
        }
    }

    @Test
    public void theWholeBodyIsDeliveredWhateverTheLimit() {
        String body = "x" + FLAG + "y" + EMOJI + "z";
        for (int limit = 1; limit <= 7; limit++) {
            assertEquals("limit " + limit, body, join(chunks(body, limit)));
        }
    }

    @Test
    public void theLastChunkIsNotShortenedForNothing() {
        assertEquals(8, MainActivity.HttpBridge.chunkEnd("abcdefgh", 0, 8));
    }

    @Test
    public void aTrailingLoneHighSurrogateIsStillSent() {
        String body = "abc\uD83D";                     // already broken at the source
        List<String> c = chunks(body, 4);
        assertEquals(body, join(c));
        assertEquals(1, c.size());
    }

    @Test
    public void aLimitLargerThanTheBodyKeepsItWhole() {
        assertEquals(3, MainActivity.HttpBridge.chunkEnd("abc", 0, 32768));
    }
}
