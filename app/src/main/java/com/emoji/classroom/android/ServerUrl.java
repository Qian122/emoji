package com.emoji.classroom.android;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

public final class ServerUrl {
    public static final String DEFAULT_URL = "http://10.0.2.2:3000";

    private ServerUrl() {
    }

    public static String normalize(String input) {
        String value = input == null ? "" : input.trim();
        if (value.isEmpty()) {
            throw new IllegalArgumentException("服务器地址不能为空");
        }
        if (!value.matches("(?i)^https?://.*")) {
            value = "http://" + value;
        }
        while (value.endsWith("/")) {
            value = value.substring(0, value.length() - 1);
        }
        try {
            URI uri = new URI(value);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if (!("http".equals(scheme) || "https".equals(scheme)) || uri.getHost() == null) {
                throw new IllegalArgumentException("请输入有效的 HTTP 或 HTTPS 地址");
            }
            if (uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null) {
                throw new IllegalArgumentException("服务器地址不能包含账号、查询参数或锚点");
            }
            String path = uri.getPath();
            if (path != null && !path.isEmpty()) {
                throw new IllegalArgumentException("请输入服务器根地址，例如 http://192.168.1.10:3000");
            }
            return uri.toString();
        } catch (URISyntaxException exception) {
            throw new IllegalArgumentException("服务器地址格式不正确", exception);
        }
    }

    public static boolean sameOrigin(String first, String second) {
        try {
            URI a = new URI(first);
            URI b = new URI(second);
            return safeEquals(a.getScheme(), b.getScheme())
                    && safeEquals(a.getHost(), b.getHost())
                    && effectivePort(a) == effectivePort(b);
        } catch (URISyntaxException exception) {
            return false;
        }
    }

    private static int effectivePort(URI uri) {
        if (uri.getPort() >= 0) {
            return uri.getPort();
        }
        return "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
    }

    private static boolean safeEquals(String first, String second) {
        return first != null && second != null && first.equalsIgnoreCase(second);
    }
}
