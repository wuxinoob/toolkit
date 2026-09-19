/**
 * `cn()` — the class-name helper every shadcn-vue component is written against.
 *
 * It is `clsx` (conditional class lists) piped through `tailwind-merge`, which
 * resolves conflicts by keeping the LAST class: `cn('p-2', 'p-4')` is `'p-4'`,
 * not `'p-2 p-4'`. That matters because every component does
 * `cn(variants({ variant, size }), props.class)` — a caller passing `class="p-4"`
 * has to be able to override the variant's own padding, and without the merge
 * both classes land in the DOM and CSS source order silently decides.
 *
 * TypeScript, like the rest of `src/components/ui` — Vite strips the types.
 */
import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
