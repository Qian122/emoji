package com.emoji.classroom.android;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.Arrays;

public class MainActivity extends Activity {
    private static final String PREFS = "emoji_android_preferences";
    private static final String PREF_SERVER_URL = "server_url";
    private static final int CAMERA_PERMISSION_REQUEST = 2001;

    private WebView webView;
    private ProgressBar progressBar;
    private View errorPanel;
    private TextView errorMessage;
    private SharedPreferences preferences;
    private PermissionRequest pendingCameraRequest;
    private String serverUrl;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        serverUrl = preferences.getString(PREF_SERVER_URL, ServerUrl.DEFAULT_URL);

        webView = findViewById(R.id.webView);
        progressBar = findViewById(R.id.progressBar);
        errorPanel = findViewById(R.id.errorPanel);
        errorMessage = findViewById(R.id.errorMessage);
        Button retryButton = findViewById(R.id.retryButton);
        Button refreshButton = findViewById(R.id.refreshButton);
        Button settingsButton = findViewById(R.id.settingsButton);

        configureWebView();
        retryButton.setOnClickListener(view -> loadServer());
        refreshButton.setOnClickListener(view -> webView.reload());
        settingsButton.setOnClickListener(view -> showServerDialog());

        if (savedInstanceState == null) {
            if (preferences.contains(PREF_SERVER_URL)) {
                loadServer();
            } else {
                showServerDialog();
            }
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        settings.setUserAgentString(settings.getUserAgentString() + " EmojiClassroomAndroid/1.0");

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new AndroidBridge(this), "EmojiAndroid");
        webView.setWebViewClient(new ClassroomWebViewClient());
        webView.setWebChromeClient(new ClassroomChromeClient());
        webView.setDownloadListener(new ClassroomDownloadListener());
    }

    private void loadServer() {
        if (!isNetworkAvailable()) {
            showConnectionError("当前设备没有可用网络。\n\n" + getString(R.string.connection_error_message));
            return;
        }
        hideConnectionError();
        webView.loadUrl(serverUrl);
    }

    private void showServerDialog() {
        int padding = Math.round(20 * getResources().getDisplayMetrics().density);
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(padding, padding / 2, padding, 0);

        TextView hint = new TextView(this);
        hint.setText("模拟器默认使用 http://10.0.2.2:3000。真机请输入运行后端电脑的局域网地址，例如 http://192.168.1.10:3000。");
        hint.setTextSize(14);
        panel.addView(hint);

        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setText(serverUrl);
        input.setSelectAllOnFocus(true);
        input.setHint("http://192.168.1.10:3000");
        panel.addView(input, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        ));

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("服务器地址")
                .setView(panel)
                .setNegativeButton("取消", null)
                .setNeutralButton("恢复模拟器默认值", null)
                .setPositiveButton("保存并连接", null)
                .create();

        dialog.setOnShowListener(ignored -> {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
                try {
                    String normalized = ServerUrl.normalize(input.getText().toString());
                    serverUrl = normalized;
                    preferences.edit().putString(PREF_SERVER_URL, normalized).apply();
                    hideKeyboard(input);
                    dialog.dismiss();
                    webView.stopLoading();
                    webView.clearHistory();
                    loadServer();
                } catch (IllegalArgumentException exception) {
                    input.setError(exception.getMessage());
                }
            });
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(view -> input.setText(ServerUrl.DEFAULT_URL));
        });
        dialog.show();
    }

    private void hideKeyboard(View view) {
        InputMethodManager manager = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        manager.hideSoftInputFromWindow(view.getWindowToken(), 0);
    }

    private boolean isNetworkAvailable() {
        ConnectivityManager manager = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        Network network = manager.getActiveNetwork();
        if (network == null) {
            return false;
        }
        NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
        return capabilities != null && (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                || capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)
                || capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET));
    }

    private void showConnectionError(String message) {
        progressBar.setVisibility(View.GONE);
        errorMessage.setText(message);
        errorPanel.setVisibility(View.VISIBLE);
    }

    private void hideConnectionError() {
        errorPanel.setVisibility(View.GONE);
    }

    private boolean isTrustedUrl(String url) {
        return url != null && ServerUrl.sameOrigin(serverUrl, url);
    }

    private void openExternal(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException exception) {
            Toast.makeText(this, "没有可打开该链接的应用", Toast.LENGTH_SHORT).show();
        }
    }

    private void requestCameraForWeb(PermissionRequest request) {
        String[] resources = request.getResources();
        boolean requestsVideo = Arrays.asList(resources).contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE);
        if (!requestsVideo || !isTrustedUrl(request.getOrigin().toString())) {
            request.deny();
            return;
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        } else {
            pendingCameraRequest = request;
            requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION_REQUEST);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != CAMERA_PERMISSION_REQUEST || pendingCameraRequest == null) {
            return;
        }
        PermissionRequest request = pendingCameraRequest;
        pendingCameraRequest = null;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        } else {
            request.deny();
            Toast.makeText(this, "摄像头权限被拒绝，可在系统设置中重新开启", Toast.LENGTH_LONG).show();
        }
    }

    private void injectAndroidDownloadSupport() {
        String script = "(function(){"
                + "if(window.__emojiAndroidDownloadInstalled)return;"
                + "window.__emojiAndroidDownloadInstalled=true;"
                + "const oldRevoke=URL.revokeObjectURL.bind(URL);"
                + "URL.revokeObjectURL=function(url){setTimeout(function(){oldRevoke(url);},15000);};"
                + "const oldClick=HTMLAnchorElement.prototype.click;"
                + "HTMLAnchorElement.prototype.click=function(){"
                + "if(this.href&&this.href.indexOf('blob:')===0&&this.download){"
                + "const href=this.href,name=this.download;"
                + "fetch(href).then(r=>r.blob()).then(blob=>{"
                + "const reader=new FileReader();"
                + "reader.onloadend=()=>EmojiAndroid.saveBase64File(String(reader.result).split(',')[1],name,blob.type||'application/octet-stream');"
                + "reader.readAsDataURL(blob);"
                + "}).catch(()=>EmojiAndroid.showMessage('文件保存失败'));return;}"
                + "oldClick.call(this);};"
                + "})();";
        webView.evaluateJavascript(script, null);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onDestroy() {
        if (pendingCameraRequest != null) {
            pendingCameraRequest.deny();
            pendingCameraRequest = null;
        }
        webView.loadUrl("about:blank");
        webView.stopLoading();
        webView.removeJavascriptInterface("EmojiAndroid");
        webView.destroy();
        super.onDestroy();
    }

    private final class ClassroomWebViewClient extends WebViewClient {
        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            super.onPageStarted(view, url, favicon);
            progressBar.setVisibility(View.VISIBLE);
            hideConnectionError();
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            progressBar.setVisibility(View.GONE);
            if (isTrustedUrl(url)) {
                injectAndroidDownloadSupport();
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (isTrustedUrl(uri.toString())) {
                return false;
            }
            openExternal(uri);
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            super.onReceivedError(view, request, error);
            if (request.isForMainFrame()) {
                showConnectionError("加载失败：" + error.getDescription() + "\n\n" + getString(R.string.connection_error_message));
            }
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
            super.onReceivedHttpError(view, request, errorResponse);
            if (request.isForMainFrame() && errorResponse.getStatusCode() >= 500) {
                showConnectionError("服务器返回 " + errorResponse.getStatusCode() + "。\n\n" + getString(R.string.connection_error_message));
            }
        }
    }

    private final class ClassroomChromeClient extends WebChromeClient {
        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            progressBar.setProgress(newProgress);
            progressBar.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            runOnUiThread(() -> requestCameraForWeb(request));
        }

        @Override
        public void onPermissionRequestCanceled(PermissionRequest request) {
            if (pendingCameraRequest == request) {
                pendingCameraRequest = null;
            }
        }
    }

    private final class ClassroomDownloadListener implements DownloadListener {
        @Override
        public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimeType, long contentLength) {
            if (url.startsWith("blob:")) {
                injectAndroidDownloadSupport();
                return;
            }
            if (!isTrustedUrl(url)) {
                openExternal(Uri.parse(url));
                return;
            }
            String filename = URLUtil.guessFileName(url, contentDisposition, mimeType);
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setMimeType(mimeType);
            request.addRequestHeader("User-Agent", userAgent);
            request.addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url));
            request.setTitle(filename);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalFilesDir(MainActivity.this, Environment.DIRECTORY_DOWNLOADS, filename);
            DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            manager.enqueue(request);
            Toast.makeText(MainActivity.this, "开始下载 " + filename, Toast.LENGTH_SHORT).show();
        }
    }

    public static final class AndroidBridge {
        private final MainActivity activity;

        AndroidBridge(MainActivity activity) {
            this.activity = activity;
        }

        @JavascriptInterface
        public void saveBase64File(String base64Data, String filename, String mimeType) {
            activity.runOnUiThread(() -> activity.saveDecodedFile(base64Data, filename, mimeType));
        }

        @JavascriptInterface
        public void showMessage(String message) {
            activity.runOnUiThread(() -> Toast.makeText(activity, message, Toast.LENGTH_SHORT).show());
        }
    }

    private void saveDecodedFile(String base64Data, String requestedName, String mimeType) {
        String filename = sanitizeFilename(requestedName);
        byte[] bytes;
        try {
            bytes = Base64.decode(base64Data, Base64.DEFAULT);
        } catch (IllegalArgumentException exception) {
            Toast.makeText(this, "文件数据无效", Toast.LENGTH_LONG).show();
            return;
        }

        try {
            Uri savedUri;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, filename);
                values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/EmojiClassroom");
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                savedUri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (savedUri == null) {
                    throw new IOException("无法创建下载文件");
                }
                try (OutputStream stream = getContentResolver().openOutputStream(savedUri)) {
                    if (stream == null) {
                        throw new IOException("无法写入下载文件");
                    }
                    stream.write(bytes);
                }
                values.clear();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                getContentResolver().update(savedUri, values, null, null);
                Toast.makeText(this, "已保存到 下载/EmojiClassroom/" + filename, Toast.LENGTH_LONG).show();
            } else {
                File appDownloads = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                if (appDownloads == null) {
                    throw new IOException("应用下载目录不可用");
                }
                File directory = new File(appDownloads, "EmojiClassroom");
                if (!directory.exists() && !directory.mkdirs()) {
                    throw new IOException("无法创建下载目录");
                }
                File output = new File(directory, filename);
                try (OutputStream stream = new FileOutputStream(output)) {
                    stream.write(bytes);
                }
                Toast.makeText(this, "已保存到应用下载目录：" + output.getAbsolutePath(), Toast.LENGTH_LONG).show();
            }
        } catch (IOException exception) {
            Toast.makeText(this, "文件保存失败：" + exception.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private String sanitizeFilename(String value) {
        String filename = value == null ? "download.bin" : value.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
        return filename.isEmpty() ? "download.bin" : filename;
    }
}
