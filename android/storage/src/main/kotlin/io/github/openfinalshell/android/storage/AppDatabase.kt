package io.github.openfinalshell.android.storage

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [ProfileEntity::class, SecretEntity::class, PrivateKeyEntity::class, ForwardEntity::class],
    version = 1,
    exportSchema = true
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun profiles(): ProfileDao
    abstract fun secrets(): SecretDao
    abstract fun privateKeys(): PrivateKeyDao
    abstract fun forwards(): ForwardDao

    companion object {
        fun create(context: Context): AppDatabase =
            Room.databaseBuilder(context, AppDatabase::class.java, "openfinalshell.db")
                .fallbackToDestructiveMigration()
                .build()
    }
}
