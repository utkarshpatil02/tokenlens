import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { Icon } from './Icon'
import type { IconName } from './Icon'

type Variant = 'default' | 'primary' | 'ghost'

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: Variant
  /** Rendered before the label, and hidden from screen readers. */
  icon?: IconName
  /** Swaps the icon for a spinner and disables the button. */
  busy?: boolean
  children: ReactNode
  className?: string
}

/**
 * The button.
 *
 * `type="button"` is the default on purpose. These sit inside forms and labels
 * in several screens, where the HTML default of `submit` would reload the page
 * and throw away an in-progress analysis that only exists in this tab.
 */
export function Button({
  variant = 'default',
  icon,
  busy = false,
  disabled,
  children,
  className,
  type = 'button',
  ...rest
}: Props) {
  const classes = [variant !== 'default' && variant, className].filter(Boolean).join(' ')
  return (
    <button
      type={type}
      className={classes || undefined}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <Icon name="spinner" /> : icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  )
}
