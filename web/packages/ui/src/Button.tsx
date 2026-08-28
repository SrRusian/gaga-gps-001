import type { ButtonHTMLAttributes } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'danger' | 'secondary';
}

export function Button({ variant = 'primary', className, ...rest }: ButtonProps) {
  const classes = ['gg-button', `gg-button--${variant}`, className].filter(Boolean).join(' ');
  return <button className={classes} {...rest} />;
}
