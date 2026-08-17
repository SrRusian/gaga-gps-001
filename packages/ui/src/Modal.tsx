import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 'large' - overlays de gestión (tabla + filtros), más ancho/alto que un formulario corto. Default 'small'. */
  size?: 'small' | 'large';
}

// Duración de la animación de entrada/salida - debe coincidir con la
// transición declarada en `.gg-modal-backdrop`/`.gg-modal-card`
// (styles.css) - un solo número, no dos lugares que puedan
// desincronizarse con el tiempo.
const TRANSITION_MS = 180;

// Overlay genérico para formularios de alta/edición cortos - antes
// cada panel Admin tenía sus campos de "crear" siempre visibles en
// una tarjeta fija, compitiendo por espacio con las listas. Un solo
// componente para los tres paneles (igual que Button/AlertBanner).
export function Modal({ open, title, onClose, children, size = 'small' }: ModalProps) {
  // `mounted` controla si el nodo existe en el DOM; `visible` controla
  // la clase que dispara la transición CSS. Se necesitan por separado
  // porque al cerrar el modal debe seguir montado unos milisegundos
  // más mientras la animación de salida corre - `open=false` no puede
  // desmontarlo de inmediato o nunca se vería la transición.
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // Doble rAF, no uno solo - con uno solo, el navegador a veces
      // fusiona el commit de `mounted` y el de `visible` en el MISMO
      // frame (nunca llega a pintar el estado oculto de por medio), y
      // la tarjeta aparece de golpe sin transición. El segundo rAF
      // fuerza a esperar un frame completo ya pintado antes de recién
      // ahí activar la clase que dispara la animación - patrón
      // estándar para animar un elemento recién montado.
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setVisible(true));
      });
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
      };
    }
    setVisible(false);
    const timeout = setTimeout(() => setMounted(false), TRANSITION_MS);
    return () => clearTimeout(timeout);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!mounted) return null;

  return (
    <div
      className={`gg-modal-backdrop${visible ? ' gg-modal-backdrop--visible' : ''}`}
      onClick={onClose}
    >
      <div
        className={`gg-modal-card${size === 'large' ? ' gg-modal-card--large' : ''}${visible ? ' gg-modal-card--visible' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="gg-modal-header">
          <h3>{title}</h3>
          <button className="gg-modal-close" onClick={onClose} aria-label="Cerrar">
            X
          </button>
        </div>
        <div className="gg-modal-body">{children}</div>
      </div>
    </div>
  );
}
