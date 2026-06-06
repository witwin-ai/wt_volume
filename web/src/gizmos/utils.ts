/**
 * Utility functions for component data extraction
 */

/**
 * Get a value from a component using the dual data source strategy
 * Checks fields array first, then values object, then returns default
 *
 * @param component - The component to extract from
 * @param fieldName - The name of the field to get
 * @param defaultValue - Default value if field is not found
 * @returns The field value or default
 */
export function getComponentValue<T>(
  component: any,
  fieldName: string,
  defaultValue: T
): T {
  // First check fields array (old format)
  const field = component.fields?.find((f: any) => f.name === fieldName);
  if (field?.value !== undefined) {
    return field.value;
  }

  // Then check values object (new format)
  if (component.values?.[fieldName] !== undefined) {
    return component.values[fieldName];
  }

  // Return default
  return defaultValue;
}

/**
 * Check if a component has a specific field
 * Checks both fields array and values object
 *
 * @param component - The component to check
 * @param fieldName - The name of the field to look for
 * @returns True if the field exists
 */
export function hasComponentField(component: any, fieldName: string): boolean {
  const hasInFields = component.fields?.some((f: any) => f.name === fieldName);
  const hasInValues = component.values?.[fieldName] !== undefined;
  return hasInFields || hasInValues;
}

/**
 * Get multiple values from a component at once
 *
 * @param component - The component to extract from
 * @param fields - Object mapping field names to default values
 * @returns Object with extracted values
 */
export function getComponentValues<T extends Record<string, any>>(
  component: any,
  fields: T
): T {
  const result = {} as T;
  for (const [key, defaultValue] of Object.entries(fields)) {
    (result as any)[key] = getComponentValue(component, key, defaultValue);
  }
  return result;
}

/**
 * Find a component by name in a components array
 *
 * @param components - Array of components
 * @param name - Component name to find
 * @returns The component or null
 */
export function findComponent(components: any[] | undefined, name: string): any | null {
  return components?.find((c: any) => c.name === name) || null;
}

/**
 * Check if a component exists by name
 *
 * @param components - Array of components
 * @param name - Component name to check
 * @returns True if component exists
 */
export function hasComponent(components: any[] | undefined, name: string): boolean {
  return components?.some((c: any) => c.name === name) || false;
}

/**
 * Check if a component inherits from a specific base class
 * Uses the base_classes array sent from backend
 *
 * @param component - The component to check
 * @param baseClassName - The base class name to look for (e.g., 'Field', 'VolumeRendererBase')
 * @returns True if the component inherits from the base class
 */
export function inheritsFrom(component: any, baseClassName: string): boolean {
  // Direct match on component name
  if (component.name === baseClassName) return true;
  // Check base_classes array
  return component.base_classes?.includes(baseClassName) || false;
}
