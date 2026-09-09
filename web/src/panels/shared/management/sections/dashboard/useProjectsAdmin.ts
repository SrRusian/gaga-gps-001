import { useMemo, useState } from 'react';
import { adminApi } from '../../api';
import type { ProjectRow } from '../../types';

export interface ProjectFormState {
  name: string;
}

export interface UseProjectsAdminOptions {
  onProjectDeleted: (deletedId: number) => void;
}

export function useProjectsAdmin({ onProjectDeleted }: UseProjectsAdminOptions) {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [projectSearch, setProjectSearch] = useState('');
  const [projectModal, setProjectModal] = useState<{ project?: ProjectRow } | null>(null);
  const [projectForm, setProjectForm] = useState<ProjectFormState>({ name: '' });

  async function loadProjects() {
    try {
      setProjects(await adminApi.get<ProjectRow[]>('/api/projects'));
    } catch {
      setProjects([]);
    }
  }

  const filteredProjects = useMemo(() => {
    if (!projectSearch.trim()) return projects;
    const q = projectSearch.trim().toLowerCase();
    return projects.filter((p) => p.name.toLowerCase().includes(q));
  }, [projects, projectSearch]);

  function openCreateProject() {
    setProjectForm({ name: '' });
    setProjectModal({});
  }

  function openEditProject(p: ProjectRow) {
    setProjectForm({ name: p.name });
    setProjectModal({ project: p });
  }

  async function saveProject() {
    if (!projectForm.name.trim()) {
      alert('El nombre del proyecto es requerido');
      return;
    }
    try {
      if (projectModal?.project) {
        await adminApi.patch(`/api/projects/${projectModal.project.id}`, { name: projectForm.name });
      } else {
        await adminApi.post('/api/projects', { name: projectForm.name });
      }
      setProjectModal(null);
      loadProjects();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error guardando proyecto');
    }
  }

  async function toggleProjectActive(p: ProjectRow) {
    await adminApi.patch(`/api/projects/${p.id}`, { active: !p.active });
    loadProjects();
  }

  async function deleteProject(p: ProjectRow) {
    const typed = prompt(
      `Esta acción no se puede deshacer. Se eliminarán también sus turnos, geocercas, equipo ` +
        `estático, incidentes e historial de alertas. Sus usuarios se desactivarán y sus ` +
        `dispositivos quedarán sin proyecto asignado (ninguno de los dos se elimina). Para ` +
        `eliminar "${p.name}", escriba exactamente su nombre:`,
    );
    if (typed === null) return;
    if (typed !== p.name) {
      alert('El nombre no coincide - no se eliminó el proyecto');
      return;
    }
    try {
      await adminApi.delete(`/api/projects/${p.id}`);
      loadProjects();
      onProjectDeleted(p.id);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error eliminando proyecto');
    }
  }

  return {
    projects,
    filteredProjects,
    projectSearch,
    setProjectSearch,
    projectModal,
    setProjectModal,
    projectForm,
    setProjectForm,
    loadProjects,
    openCreateProject,
    openEditProject,
    saveProject,
    toggleProjectActive,
    deleteProject,
  };
}

export type ProjectsAdmin = ReturnType<typeof useProjectsAdmin>;
