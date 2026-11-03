import type { UiEnvironment } from '@shared/uiEnvironment'

let environment: UiEnvironment | undefined
export const getPlatformEnvironment = (): UiEnvironment | undefined => environment
export function setPlatformEnvironment(value: UiEnvironment): void {
  environment = Object.freeze({ ...value })
}
