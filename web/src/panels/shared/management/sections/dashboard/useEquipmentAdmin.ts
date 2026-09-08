import { circleToPolygon, EQUIPMENT_CORE_COLOR, EQUIPMENT_OUTER_COLOR } from '@gaga-gps/map-core';
import type { EquipmentMarkerData } from '@gaga-gps/map-core';
import type { Feature, FeatureCollection } from 'geojson';
import maplibregl from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { adminApi } from '../../api';
import type { DeviceRow, EquipmentRow } from '../../types';
import type { Scope } from './scope';

const EQUIP_PREVIEW_SOURCE_ID = 'equipment-draft-preview';

export interface EquipmentFormState {
  name: string;
  type: string;
  swingRadius: string;
  safetyRadius: string;
  linkedDeviceId: string;
}

export interface UseEquipmentAdminOptions {
  map: maplibregl.Map | null;
  scope: Scope;
  allDevices: DeviceRow[];
  equipmentMarkerRef: MutableRefObject<maplibregl.Marker | null>;
  onDeviceLinked: () => void;
}

// Preview amarillo/azul (EQUIP_PREVIEW_SOURCE_ID) es exclusivo de equipo estatico - geocercas tiene
// el suyo propio en useGeofencesAdmin. equipmentMarkerRef lo crea el orquestador (mismo motivo que
// drawRef/circleMarkerRef en useGeofencesAdmin: el click handler compartido del mapa necesita
// decidir entre "coloco equipo" o "fijo geocerca" segun cual panel este abierto).
export function useEquipmentAdmin({
  map,
  scope,
  allDevices,
  equipmentMarkerRef,
  onDeviceLinked,
}: UseEquipmentAdminOptions) {
  const [allEquipment, setAllEquipment] = useState<EquipmentRow[]>([]);
  const [showEquipPanel, setShowEquipPanel] = useState(false);
  const [placingEquipment, setPlacingEquipment] = useState(false);
  const [equipTargetProjectId, setEquipTargetProjectId] = useState('');
  const [equipmentEditingId, setEquipmentEditingId] = useState<number | null>(null);
  const [equipmentPosition, setEquipmentPosition] = useState<{ lat: number; lon: number } | null>(null);
  const [equipmentForm, setEquipmentForm] = useState<EquipmentFormState>({
    name: '',
    type: '',
    linkedDeviceId: '',
    swingRadius: '',
    safetyRadius: '',
  });

  const placingEquipmentRef = useRef(placingEquipment);
  placingEquipmentRef.current = placingEquipment;

  async function loadEquipment() {
    setAllEquipment(await adminApi.get<EquipmentRow[]>('/api/equipment'));
  }

  const scopedEquipment = useMemo(() => {
    if (scope === 'global') return allEquipment;
    if (typeof scope === 'number') return allEquipment.filter((eq) => eq.project_id === scope);
    return [];
  }, [allEquipment, scope]);

  const equipmentForLayer: EquipmentMarkerData[] = useMemo(
    () =>
      scopedEquipment.map((eq) => ({
        id: eq.id,
        name: eq.name,
        latitude: eq.latitude,
        longitude: eq.longitude,
        swingRadiusMeters: eq.swing_radius,
        safetyRadiusMeters: eq.safety_radius,
        linkedDeviceId: eq.linked_device_id,
      })),
    [scopedEquipment],
  );

  const linkableDevices = useMemo(() => {
    const targetProjectId =
      typeof scope === 'number'
        ? scope
        : equipmentEditingId != null
          ? (allEquipment.find((e) => e.id === equipmentEditingId)?.project_id ?? null)
          : equipTargetProjectId
            ? Number(equipTargetProjectId)
            : null;
    if (targetProjectId == null) return [];
    const linkedElsewhere = new Set(
      allEquipment
        .filter((eq) => eq.linked_device_id && eq.id !== equipmentEditingId)
        .map((eq) => eq.linked_device_id),
    );
    return allDevices.filter((d) => d.project_id === targetProjectId && !linkedElsewhere.has(d.unique_id));
  }, [allDevices, allEquipment, scope, equipTargetProjectId, equipmentEditingId]);

  function findLinkedEquipmentName(deviceUniqueId: string): string | undefined {
    return allEquipment.find((eq) => eq.linked_device_id === deviceUniqueId)?.name;
  }

  function ensureEquipmentDraftLayer(m: maplibregl.Map) {
    if (m.getSource(EQUIP_PREVIEW_SOURCE_ID)) return;
    const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };
    m.addSource(EQUIP_PREVIEW_SOURCE_ID, { type: 'geojson', data: empty });
    m.addLayer({
      id: `${EQUIP_PREVIEW_SOURCE_ID}-outer-fill`,
      type: 'fill',
      source: EQUIP_PREVIEW_SOURCE_ID,
      filter: ['==', ['get', 'ring'], 'safety'],
      paint: { 'fill-color': EQUIPMENT_OUTER_COLOR, 'fill-opacity': 0.12 },
    });
    m.addLayer({
      id: `${EQUIP_PREVIEW_SOURCE_ID}-outer-line`,
      type: 'line',
      source: EQUIP_PREVIEW_SOURCE_ID,
      filter: ['==', ['get', 'ring'], 'safety'],
      paint: { 'line-color': EQUIPMENT_OUTER_COLOR, 'line-width': 2, 'line-dasharray': [2, 1] },
    });
    m.addLayer({
      id: `${EQUIP_PREVIEW_SOURCE_ID}-core-fill`,
      type: 'fill',
      source: EQUIP_PREVIEW_SOURCE_ID,
      filter: ['==', ['get', 'ring'], 'swing'],
      paint: { 'fill-color': EQUIPMENT_CORE_COLOR, 'fill-opacity': 0.35 },
    });
    m.addLayer({
      id: `${EQUIP_PREVIEW_SOURCE_ID}-core-line`,
      type: 'line',
      source: EQUIP_PREVIEW_SOURCE_ID,
      filter: ['==', ['get', 'ring'], 'swing'],
      paint: { 'line-color': EQUIPMENT_CORE_COLOR, 'line-width': 2 },
    });
  }

  useEffect(() => {
    if (!map) return;
    const source = map.getSource(EQUIP_PREVIEW_SOURCE_ID) as GeoJSONSource | undefined;
    if (!source) return;
    const features: Feature[] = [];
    if (showEquipPanel && equipmentPosition) {
      const swingRadius = parseFloat(equipmentForm.swingRadius);
      const safetyRadius = parseFloat(equipmentForm.safetyRadius);
      if (safetyRadius > 0) {
        features.push({
          type: 'Feature',
          properties: { ring: 'safety' },
          geometry: circleToPolygon(equipmentPosition.lat, equipmentPosition.lon, safetyRadius),
        });
      }
      if (swingRadius > 0) {
        features.push({
          type: 'Feature',
          properties: { ring: 'swing' },
          geometry: circleToPolygon(equipmentPosition.lat, equipmentPosition.lon, swingRadius),
        });
      }
    }
    source.setData({ type: 'FeatureCollection', features });
  }, [map, showEquipPanel, equipmentPosition, equipmentForm.swingRadius, equipmentForm.safetyRadius]);

  function clearEquipmentDraftPreview() {
    if (!map) return;
    const source = map.getSource(EQUIP_PREVIEW_SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData({ type: 'FeatureCollection', features: [] });
  }

  function placeEquipmentMarker(lat: number, lon: number) {
    if (!map) return;
    if (equipmentMarkerRef.current) equipmentMarkerRef.current.remove();
    const marker = new maplibregl.Marker({ color: EQUIPMENT_CORE_COLOR, draggable: true })
      .setLngLat([lon, lat])
      .addTo(map);
    marker.on('dragend', () => {
      const lngLat = marker.getLngLat();
      setEquipmentPosition({ lat: lngLat.lat, lon: lngLat.lng });
    });
    equipmentMarkerRef.current = marker;
  }

  function resetEquipmentForm() {
    setEquipTargetProjectId('');
    setEquipmentEditingId(null);
    setEquipmentForm({ name: '', type: '', swingRadius: '', safetyRadius: '', linkedDeviceId: '' });
    setEquipmentPosition(null);
    setPlacingEquipment(false);
    clearEquipmentDraftPreview();
    if (equipmentMarkerRef.current) {
      equipmentMarkerRef.current.remove();
      equipmentMarkerRef.current = null;
    }
  }

  function closeEquipPanel() {
    resetEquipmentForm();
    setShowEquipPanel(false);
  }

  function editEquipmentRow(eq: EquipmentRow) {
    if (!map) return;
    setShowEquipPanel(true);
    setEquipmentEditingId(eq.id);
    setEquipmentForm({
      name: eq.name,
      type: eq.type,
      swingRadius: String(eq.swing_radius),
      safetyRadius: String(eq.safety_radius),
      linkedDeviceId: eq.linked_device_id ?? '',
    });
    setEquipmentPosition({ lat: eq.latitude, lon: eq.longitude });
    placeEquipmentMarker(eq.latitude, eq.longitude);
    map.flyTo({ center: [eq.longitude, eq.latitude], zoom: 16 });
  }

  async function saveEquipmentRow() {
    const isEditing = equipmentEditingId != null;
    const effectiveProjectId =
      typeof scope === 'number' ? scope : equipTargetProjectId ? Number(equipTargetProjectId) : null;
    if (!isEditing && !effectiveProjectId) {
      alert('Selecciona un proyecto');
      return;
    }
    const swingRadius = parseFloat(equipmentForm.swingRadius);
    const safetyRadius = parseFloat(equipmentForm.safetyRadius);
    if (!equipmentForm.name || !equipmentForm.type || !equipmentPosition || !swingRadius || !safetyRadius) {
      alert('Complete nombre, tipo, posición (clic en el mapa o arrastre el marcador) y ambos radios');
      return;
    }
    try {
      const payload = {
        name: equipmentForm.name,
        type: equipmentForm.type,
        latitude: equipmentPosition.lat,
        longitude: equipmentPosition.lon,
        swingRadius,
        safetyRadius,
        linkedDeviceId: equipmentForm.linkedDeviceId || null,
        ...(isEditing ? {} : { projectId: effectiveProjectId }),
      };
      if (isEditing) {
        await adminApi.patch(`/api/equipment/${equipmentEditingId}`, payload);
      } else {
        await adminApi.post('/api/equipment', payload);
      }
      resetEquipmentForm();
      loadEquipment();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error guardando el equipo');
    }
  }

  async function deleteEquipmentRow(eq: EquipmentRow) {
    const linkedNote = eq.linked_device_id
      ? ` La tableta vinculada (${eq.linked_device_id}) NO se elimina - solo queda sin equipo asignado.`
      : '';
    const typed = prompt(
      `Esta acción no se puede deshacer. Se eliminarán las alertas de aproximación activas contra ` +
        `este equipo.${linkedNote} Para eliminar "${eq.name}", escriba exactamente su nombre:`,
    );
    if (typed === null) return;
    if (typed !== eq.name) {
      alert('El nombre no coincide - no se eliminó el equipo');
      return;
    }
    try {
      await adminApi.delete(`/api/equipment/${eq.id}`);
      loadEquipment();
      if (eq.linked_device_id) onDeviceLinked();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error eliminando el equipo');
    }
  }

  return {
    allEquipment,
    allDevices,
    scopedEquipment,
    equipmentForLayer,
    linkableDevices,
    findLinkedEquipmentName,
    showEquipPanel,
    setShowEquipPanel,
    placingEquipment,
    setPlacingEquipment,
    placingEquipmentRef,
    equipTargetProjectId,
    setEquipTargetProjectId,
    equipmentEditingId,
    equipmentPosition,
    setEquipmentPosition,
    equipmentForm,
    setEquipmentForm,
    loadEquipment,
    ensureEquipmentDraftLayer,
    placeEquipmentMarker,
    resetEquipmentForm,
    closeEquipPanel,
    editEquipmentRow,
    saveEquipmentRow,
    deleteEquipmentRow,
  };
}

export type EquipmentAdmin = ReturnType<typeof useEquipmentAdmin>;
