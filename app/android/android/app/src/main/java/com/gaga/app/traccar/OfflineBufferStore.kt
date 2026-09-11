package com.gaga.app.traccar

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.location.Location

data class BufferedPosition(
    val rowId: Long,
    val serverUrl: String,
    val deviceId: String,
    val password: String,
    val location: Location,
)

// SQLite (no una base aparte, ya viene con Android) en vez de un JSON en SharedPreferences - a
// varios miles de puntos (offline de horas, no minutos) reescribir un blob completo en cada
// insercion se vuelve lento; una tabla indexada por id soporta esto sin esfuerzo.
class OfflineBufferStore(context: Context) :
    SQLiteOpenHelper(context.applicationContext, "gaga_traccar_buffer.db", null, 1) {

    companion object {
        private const val TABLE = "buffer"
        // limite de seguridad, no de operacion normal - evita crecer sin fin si la tableta pasa
        // dias sin red; para el caso real (horas) nunca deberia acercarse a este numero
        private const val MAX_ROWS = 200_000
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE $TABLE (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                server_url TEXT NOT NULL,
                device_id TEXT NOT NULL,
                password TEXT NOT NULL,
                lat REAL NOT NULL,
                lon REAL NOT NULL,
                time INTEGER NOT NULL,
                has_speed INTEGER NOT NULL,
                speed REAL NOT NULL,
                has_bearing INTEGER NOT NULL,
                bearing REAL NOT NULL,
                has_altitude INTEGER NOT NULL,
                altitude REAL NOT NULL,
                has_accuracy INTEGER NOT NULL,
                accuracy REAL NOT NULL
            )
            """.trimIndent(),
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        db.execSQL("DROP TABLE IF EXISTS $TABLE")
        onCreate(db)
    }

    @Synchronized
    fun add(serverUrl: String, deviceId: String, password: String, location: Location) {
        val values = ContentValues().apply {
            put("server_url", serverUrl)
            put("device_id", deviceId)
            put("password", password)
            put("lat", location.latitude)
            put("lon", location.longitude)
            put("time", location.time)
            put("has_speed", if (location.hasSpeed()) 1 else 0)
            put("speed", location.speed.toDouble())
            put("has_bearing", if (location.hasBearing()) 1 else 0)
            put("bearing", location.bearing.toDouble())
            put("has_altitude", if (location.hasAltitude()) 1 else 0)
            put("altitude", location.altitude)
            put("has_accuracy", if (location.hasAccuracy()) 1 else 0)
            put("accuracy", location.accuracy.toDouble())
        }
        writableDatabase.insert(TABLE, null, values)

        val count = count()
        if (count > MAX_ROWS) {
            // se descartan los mas viejos por encima del tope de seguridad - nunca deberia pasar
            // en operacion normal, solo si la tableta paso dias enteros sin red
            writableDatabase.execSQL(
                "DELETE FROM $TABLE WHERE id IN (SELECT id FROM $TABLE ORDER BY id ASC LIMIT ${count - MAX_ROWS})",
            )
        }
    }

    @Synchronized
    fun peekOldest(limit: Int): List<BufferedPosition> {
        val results = mutableListOf<BufferedPosition>()
        readableDatabase.rawQuery(
            "SELECT id, server_url, device_id, password, lat, lon, time, has_speed, speed, " +
                "has_bearing, bearing, has_altitude, altitude, has_accuracy, accuracy " +
                "FROM $TABLE ORDER BY id ASC LIMIT ?",
            arrayOf(limit.toString()),
        ).use { cursor ->
            while (cursor.moveToNext()) {
                val location = Location("buffered").apply {
                    latitude = cursor.getDouble(4)
                    longitude = cursor.getDouble(5)
                    time = cursor.getLong(6)
                    if (cursor.getInt(7) == 1) speed = cursor.getDouble(8).toFloat()
                    if (cursor.getInt(9) == 1) bearing = cursor.getDouble(10).toFloat()
                    if (cursor.getInt(11) == 1) altitude = cursor.getDouble(12)
                    if (cursor.getInt(13) == 1) accuracy = cursor.getDouble(14).toFloat()
                }
                results.add(
                    BufferedPosition(
                        rowId = cursor.getLong(0),
                        serverUrl = cursor.getString(1),
                        deviceId = cursor.getString(2),
                        password = cursor.getString(3),
                        location = location,
                    ),
                )
            }
        }
        return results
    }

    @Synchronized
    fun delete(rowId: Long) {
        writableDatabase.delete(TABLE, "id = ?", arrayOf(rowId.toString()))
    }

    @Synchronized
    fun count(): Int {
        readableDatabase.rawQuery("SELECT COUNT(*) FROM $TABLE", null).use { cursor ->
            cursor.moveToFirst()
            return cursor.getInt(0)
        }
    }
}
