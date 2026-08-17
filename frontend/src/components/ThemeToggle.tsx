import type { Theme } from '../theme'

const OPTIONS: { value: Theme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Auto' },
]

interface Props {
  theme: Theme
  onChange: (theme: Theme) => void
}

/**
 * A segmented control rather than a single sun/moon button.
 *
 * A two-state toggle cannot express "follow the system", so it has to either
 * drop that option or hide it behind a long-press nobody finds. Three visible
 * segments say what the choices are and which one is active.
 */
export function ThemeToggle({ theme, onChange }: Props) {
  return (
    <div className="theme-toggle" role="group" aria-label="Colour theme">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`theme-option${theme === option.value ? ' chosen' : ''}`}
          aria-pressed={theme === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
