package io.github.openfinalshell.android.storage

import android.content.Context
import androidx.room.Database
import androidx.room.migration.Migration
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
    entities = [
        ProfileEntity::class,
        SecretEntity::class,
        PrivateKeyEntity::class,
        ForwardEntity::class,
        ConnectionGroupEntity::class,
        SavedProxyEntity::class,
        KnownHostEntity::class,
        DocumentEntity::class
    ],
    version = 2,
    exportSchema = true
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun profiles(): ProfileDao
    abstract fun secrets(): SecretDao
    abstract fun privateKeys(): PrivateKeyDao
    abstract fun forwards(): ForwardDao
    abstract fun groups(): ConnectionGroupDao
    abstract fun proxies(): SavedProxyDao
    abstract fun knownHosts(): KnownHostDao
    abstract fun documents(): DocumentDao

    companion object {
        /** Non-destructive schema upgrade for databases created by version 1. */
        val MIGRATION_1_2: Migration = object : Migration(1, 2) {
            override fun migrate(database: SupportSQLiteDatabase) {
                addColumn(database, "profiles", "profileJson", "TEXT")
                addColumn(database, "profiles", "protocol", "TEXT NOT NULL DEFAULT 'ssh'")
                addColumn(database, "profiles", "groupId", "TEXT")
                addColumn(database, "profiles", "color", "TEXT")
                addColumn(database, "profiles", "flag", "TEXT")
                addColumn(database, "profiles", "terminalJson", "TEXT")
                addColumn(database, "profiles", "optionsJson", "TEXT")
                addColumn(database, "profiles", "proxyMode", "TEXT")
                addColumn(database, "profiles", "proxyId", "TEXT")
                addColumn(database, "profiles", "jumpHostId", "TEXT")
                addColumn(database, "profiles", "note", "TEXT")
                addColumn(database, "profiles", "createdAt", "INTEGER NOT NULL DEFAULT 0")
                addColumn(database, "profiles", "updatedAt", "INTEGER NOT NULL DEFAULT 0")
                addColumn(database, "profiles", "lastUsedAt", "INTEGER")
                addColumn(database, "private_keys", "updatedAt", "INTEGER NOT NULL DEFAULT 0")
                database.execSQL("CREATE INDEX IF NOT EXISTS index_profiles_groupId ON profiles(groupId)")
                database.execSQL(
                    """CREATE TABLE IF NOT EXISTS connection_groups (
                        id TEXT NOT NULL PRIMARY KEY,
                        name TEXT NOT NULL,
                        parentId TEXT,
                        sortOrder REAL NOT NULL
                    )"""
                )
                database.execSQL(
                    """CREATE TABLE IF NOT EXISTS saved_proxies (
                        id TEXT NOT NULL PRIMARY KEY,
                        name TEXT NOT NULL,
                        type TEXT NOT NULL,
                        host TEXT NOT NULL,
                        port INTEGER NOT NULL,
                        username TEXT,
                        passwordRef TEXT,
                        createdAt INTEGER NOT NULL,
                        updatedAt INTEGER NOT NULL
                    )"""
                )
                database.execSQL(
                    """CREATE TABLE IF NOT EXISTS known_hosts (
                        `key` TEXT NOT NULL PRIMARY KEY,
                        keyType TEXT NOT NULL,
                        fingerprintSha256 TEXT NOT NULL,
                        addedAt INTEGER NOT NULL
                    )"""
                )
                database.execSQL(
                    """CREATE TABLE IF NOT EXISTS documents (
                        name TEXT NOT NULL PRIMARY KEY,
                        json TEXT NOT NULL
                    )"""
                )
            }
        }

        fun create(context: Context): AppDatabase =
            Room.databaseBuilder(context, AppDatabase::class.java, "openfinalshell.db")
                .addMigrations(MIGRATION_1_2)
                .build()

        private fun addColumn(database: SupportSQLiteDatabase, table: String, column: String, definition: String) {
            database.execSQL("ALTER TABLE $table ADD COLUMN $column $definition")
        }
    }
}
