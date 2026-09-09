import { useMemo, useState } from 'react';
import { adminApi } from '../../api';
import type { UserRow } from '../../types';
import type { Scope } from './scope';

export interface UserFormState {
  email: string;
  name: string;
  password: string;
  role: string;
  projectId: string;
}

export interface UseUsersAdminOptions {
  scope: Scope;
  isAdmin: boolean;
}

export function useUsersAdmin({ scope, isAdmin }: UseUsersAdminOptions) {
  const [allUsers, setAllUsers] = useState<UserRow[]>([]);
  const [userSearch, setUserSearch] = useState('');
  const [userModal, setUserModal] = useState<{ user?: UserRow } | null>(null);
  const [userForm, setUserForm] = useState<UserFormState>({
    email: '',
    name: '',
    password: '',
    role: 'operator',
    projectId: '',
  });

  async function loadUsers() {
    setAllUsers(await adminApi.get<UserRow[]>('/api/users'));
  }

  const scopedUsers = useMemo(() => {
    const base = scope === 'global' ? allUsers : allUsers.filter((u) => u.project_id === scope);
    if (!userSearch.trim()) return base;
    const q = userSearch.trim().toLowerCase();
    return base.filter((u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
  }, [allUsers, scope, userSearch]);

  function openCreateUser() {
    setUserForm({ email: '', name: '', password: '', role: 'operator', projectId: '' });
    setUserModal({});
  }

  function openEditUser(u: UserRow) {
    setUserForm({
      email: u.email,
      name: u.name,
      password: '',
      role: u.role,
      projectId: u.project_id != null ? String(u.project_id) : '',
    });
    setUserModal({ user: u });
  }

  async function saveUser() {
    if (!userForm.email.trim() || !userForm.name.trim()) {
      alert('Email y nombre son requeridos');
      return;
    }
    try {
      if (userModal?.user) {
        await adminApi.patch(`/api/users/${userModal.user.id}`, {
          ...(isAdmin ? { email: userForm.email, name: userForm.name } : {}),
          role: userForm.role,
          ...(isAdmin
            ? {
                projectId:
                  userForm.role === 'admin'
                    ? null
                    : userForm.projectId
                      ? Number(userForm.projectId)
                      : null,
              }
            : {}),
        });
      } else {
        if (!userForm.password) {
          alert('La contraseña es requerida');
          return;
        }
        const projectId =
          userForm.role === 'admin'
            ? null
            : scope === 'global'
              ? userForm.projectId
                ? Number(userForm.projectId)
                : null
              : scope;
        await adminApi.post('/api/users', { ...userForm, projectId });
      }
      setUserModal(null);
      loadUsers();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error guardando usuario');
    }
  }

  async function toggleUserActive(u: UserRow) {
    try {
      await adminApi.patch(`/api/users/${u.id}`, { active: !u.active });
      loadUsers();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error actualizando usuario');
    }
  }

  async function deleteUser(u: UserRow) {
    const typed = prompt(
      `Esta acción no se puede deshacer. Se eliminará también su historial de turnos de operador. ` +
        `Los turnos que supervisa y los incidentes que reportó/resolvió quedarán sin ese usuario ` +
        `asignado (no se eliminan). Para eliminar a "${u.name}", escriba exactamente su nombre:`,
    );
    if (typed === null) return;
    if (typed !== u.name) {
      alert('El nombre no coincide - no se eliminó el usuario');
      return;
    }
    try {
      await adminApi.delete(`/api/users/${u.id}?force=true`);
      loadUsers();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error eliminando usuario');
    }
  }

  return {
    allUsers,
    scopedUsers,
    userSearch,
    setUserSearch,
    userModal,
    setUserModal,
    userForm,
    setUserForm,
    loadUsers,
    openCreateUser,
    openEditUser,
    saveUser,
    toggleUserActive,
    deleteUser,
  };
}

export type UsersAdmin = ReturnType<typeof useUsersAdmin>;
