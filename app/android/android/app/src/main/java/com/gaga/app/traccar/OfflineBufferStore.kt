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
    SQLiteOpenHelper(context.applicationContext, "gaga_traccar_buffer.db", null, 2) {

    companion object {
        private const val TABLE = "buffer"

        // ventana deslizante: se conserva la ULTIMA hora de recorrido, no la primera (pedido
        // explicito). Si la tableta pasa 3 horas sin red, al recuperarla manda el tramo de la
        // hora 2 a la 3, que es el relevante - no el de la hora 0 a la 1, que ya no le sirve a
        // nadie. Se mide contra el punto MAS NUEVO del propio buffer, no contra el reloj, para
        // que no dependa de cuando se llame ni de un cambio de hora del sistema.
        private const val RETENTION_MS = 60L * 60L * 1000L

        // red de seguridad por si algo llenara el buffer mucho mas rapido que 1/seg - a la
        // cadencia normal, una hora son ~3600 filas y esto nunca se alcanza
        private const val MAX_ROWS = 50_000
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
        // la poda por ventana de tiempo corre en cada insercion - sin indice seria un recorrido
        // completo de la tabla una vez por segundo
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_buffer_time ON $TABLE (time)")
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

        // ventana deslizante de la ultima hora - ver RETENTION_MS
        writableDatabase.execSQL(
            "DELETE FROM $TABLE WHERE time < (SELECT MAX(time) FROM $TABLE) - $RETENTION_MS",
        )

        val count = count()
        if (count > MAX_ROWS) {
            // se descartan los mas viejos por encima del tope de seguridad - nunca deberia pasar
            // en operacion normal, solo si algo encolara mucho mas rapido que 1/seg
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
