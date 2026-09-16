package io.github.openfinalshell.android.transfer;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/** Test APK only. This separate provider process has no access to the app's Kotlin runtime. */
public final class SafFixtureProvider extends ContentProvider {
    public static final String AUTHORITY = "io.github.openfinalshell.android.test.saf-fixture";
    public static final byte[] INITIAL = "0123456789abcdef".getBytes(StandardCharsets.UTF_8);

    private static final class Fixture {
        final File directory;
        volatile boolean denied;
        final Map<String, Node> nodes = new ConcurrentHashMap<>();
        Fixture(File directory) { this.directory = directory; }
    }
    private static final class Node {
        final String id, name, kind, parent;
        final File file;
        final AtomicInteger opened = new AtomicInteger(), completed = new AtomicInteger();
        volatile Throwable writerFailure;
        Node(String id, String name, File file, String kind, String parent) {
            this.id = id; this.name = name; this.file = file; this.kind = kind; this.parent = parent;
        }
    }
    private final Map<String, Fixture> fixtures = new ConcurrentHashMap<>();
    @Override public boolean onCreate() { return true; }

    @Override public Bundle call(String method, String arg, Bundle extras) {
        try { return callFixture(method, arg, extras); }
        catch (IOException failure) { throw new IllegalStateException("test fixture IO failed", failure); }
    }
    private Bundle callFixture(String method, String arg, Bundle extras) throws IOException {
        if (method.equals("fixture:create")) {
            String id = UUID.randomUUID().toString();
            File dir = new File(Objects.requireNonNull(getContext()).getCacheDir(), "saf-fixture-" + id);
            if (!dir.mkdir()) throw new IOException("fixture directory creation failed");
            Fixture fixture = new Fixture(dir);
            fixture.nodes.put("root", new Node("root", "root", dir, "directory", null));
            for (String kind : new String[]{"file", "pipe-source", "pipe-sink", "bad-name"}) {
                File file = new File(dir, kind);
                Files.write(file.toPath(), INITIAL);
                fixture.nodes.put(kind, new Node(kind, kind.equals("bad-name") ? "../escape" : kind + ".bin", file, kind, "root"));
            }
            fixtures.put(id, fixture);
            Bundle result = new Bundle(); result.putString("id", id); return result;
        }
        if (method.equals("android:createDocument")) {
            Uri parentUri = Objects.requireNonNull(Objects.requireNonNull(extras).getParcelable("uri"));
            Fixture fixture = resolveFixture(parentUri);
            Node parent = resolveNode(fixture, parentUri);
            if (!parent.kind.equals("directory")) throw new IllegalArgumentException("not a directory");
            String name = Objects.requireNonNull(extras.getString(DocumentsContract.Document.COLUMN_DISPLAY_NAME));
            if (name.trim().isEmpty() || name.equals(".") || name.equals("..") || name.contains("/") || name.contains("\\") || name.indexOf(0) >= 0)
                throw new IllegalArgumentException("invalid name");
            boolean directory = DocumentsContract.Document.MIME_TYPE_DIR.equals(extras.getString(DocumentsContract.Document.COLUMN_MIME_TYPE));
            String nodeId = UUID.randomUUID().toString();
            // Display names never become filesystem paths, including intentionally invalid metadata.
            File file = new File(parent.file, nodeId);
            if (!(directory ? file.mkdir() : file.createNewFile())) throw new IOException("create failed");
            fixture.nodes.put(nodeId, new Node(nodeId, name, file, directory ? "directory" : "file", parent.id));
            String fixtureId = DocumentsContract.getDocumentId(parentUri).split(":", 2)[0];
            Uri created = DocumentsContract.buildDocumentUriUsingTree(parentUri, fixtureId + ":" + nodeId);
            Bundle result = new Bundle(); result.putParcelable("uri", created); return result;
        }
        Fixture fixture = fixtures.get(arg);
        if (fixture == null) throw new FileNotFoundException("unknown test fixture");
        Bundle result = new Bundle();
        switch (method) {
            case "fixture:deny": fixture.denied = true; return result;
            case "fixture:snapshot":
                Node node = Objects.requireNonNull(fixture.nodes.get(Objects.requireNonNull(extras).getString("node")));
                result.putByteArray("bytes", Files.readAllBytes(node.file.toPath()));
                result.putInt("opened", node.opened.get()); result.putInt("completed", node.completed.get());
                result.putBoolean("writerFailed", node.writerFailure != null); return result;
            case "fixture:delete":
                fixtures.remove(arg);
                File root = fixture.directory.getCanonicalFile();
                if (!Objects.equals(root.getParentFile(), Objects.requireNonNull(getContext()).getCacheDir().getCanonicalFile()) || !root.getName().startsWith("saf-fixture-"))
                    throw new IOException("invalid fixture cleanup root");
                deleteFixture(root); return result;
            default: throw new UnsupportedOperationException(method);
        }
    }
    private static void deleteFixture(File file) throws IOException {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteFixture(child);
        if (!file.delete()) throw new IOException("fixture cleanup failed");
    }
    private Fixture resolveFixture(Uri uri) {
        String id = DocumentsContract.getDocumentId(uri).split(":", 2)[0];
        Fixture fixture = Objects.requireNonNull(fixtures.get(id), "unknown fixture");
        if (fixture.denied) throw new SecurityException("test document permission revoked");
        return fixture;
    }
    private Node resolveNode(Fixture fixture, Uri uri) {
        String id = DocumentsContract.getDocumentId(uri).split(":", 2)[1];
        return Objects.requireNonNull(fixture.nodes.get(id), "unknown document");
    }
    @Override public String getType(Uri uri) {
        return resolveNode(resolveFixture(uri), uri).kind.equals("directory") ? DocumentsContract.Document.MIME_TYPE_DIR : "application/octet-stream";
    }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        Fixture fixture = resolveFixture(uri);
        Node node = resolveNode(fixture, uri);
        String[] columns = projection == null ? new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE} : projection;
        MatrixCursor cursor = new MatrixCursor(columns);
        String fixtureId = DocumentsContract.getDocumentId(uri).split(":", 2)[0];
        boolean children = "children".equals(uri.getLastPathSegment());
        for (Node entry : children ? fixture.nodes.values() : Collections.singletonList(node)) {
            if (children && !Objects.equals(entry.parent, node.id)) continue;
            Object[] row = new Object[columns.length];
            for (int i = 0; i < columns.length; i++) {
                switch (columns[i]) {
                    case DocumentsContract.Document.COLUMN_DOCUMENT_ID: row[i] = fixtureId + ":" + entry.id; break;
                    case OpenableColumns.DISPLAY_NAME: row[i] = entry.name; break;
                    case OpenableColumns.SIZE: row[i] = entry.kind.equals("directory") ? 0L : entry.file.length(); break;
                    case DocumentsContract.Document.COLUMN_MIME_TYPE: row[i] = entry.kind.equals("directory") ? DocumentsContract.Document.MIME_TYPE_DIR : "application/octet-stream"; break;
                    default: break;
                }
            }
            cursor.addRow(row);
        }
        return cursor;
    }
    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        Node node = resolveNode(resolveFixture(uri), uri);
        try {
            if (node.kind.equals("pipe-source")) {
                if (!mode.equals("r")) throw new FileNotFoundException("read-only source");
                node.opened.incrementAndGet();
                ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
                Thread writer = new Thread(() -> {
                    try (OutputStream output = new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])) {
                        output.write(Files.readAllBytes(node.file.toPath()));
                    } catch (IOException expected) { /* The seek probe closes its reader without reading. */ }
                }, "saf-fixture-source");
                writer.setDaemon(true); writer.start(); return pipe[0];
            }
            if (node.kind.equals("pipe-sink")) {
                if (!mode.equals("wt")) throw new FileNotFoundException("sequential truncate-only sink");
                node.opened.incrementAndGet(); Files.write(node.file.toPath(), new byte[0]);
                ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
                Thread reader = new Thread(() -> {
                    try (InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(pipe[0]); OutputStream output = new FileOutputStream(node.file)) {
                        byte[] buffer = new byte[4096]; int count;
                        while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
                    } catch (Throwable failure) { node.writerFailure = failure; }
                    finally { node.completed.incrementAndGet(); }
                }, "saf-fixture-sink");
                reader.setDaemon(true); reader.start(); return pipe[1];
            }
            if (node.kind.equals("directory")) throw new FileNotFoundException("directory");
            node.opened.incrementAndGet();
            return ParcelFileDescriptor.open(node.file, ParcelFileDescriptor.parseMode(mode));
        } catch (IOException failure) { throw new FileNotFoundException("fixture open failed: " + failure.getClass().getSimpleName()); }
    }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] selectionArgs) { throw new UnsupportedOperationException(); }
}
