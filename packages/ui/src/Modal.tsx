import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  size?: 'small' | 'large';
}

const TRANSITION_MS = 180;

export function Modal({ open, title, onClose, children, size = 'small' }: ModalProps) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
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
