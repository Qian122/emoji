package com.emoji.classroom.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ServerUrlTest {
    @Test
    public void addsHttpSchemeAndRemovesTrailingSlash() {
        assertEquals("http://192.168.1.20:3000", ServerUrl.normalize("192.168.1.20:3000/"));
    }

    @Test(expected = IllegalArgumentException.class)
    public void rejectsPathInsteadOfServerRoot() {
        ServerUrl.normalize("http://localhost:3000/api");
    }

    @Test
    public void comparesOriginsUsingDefaultPorts() {
        assertTrue(ServerUrl.sameOrigin("https://example.com", "https://example.com/page"));
        assertTrue(ServerUrl.sameOrigin("http://example.com", "http://example.com:80/page"));
        assertFalse(ServerUrl.sameOrigin("https://example.com", "http://example.com"));
        assertFalse(ServerUrl.sameOrigin("http://example.com", "http://other.example.com"));
    }
}
