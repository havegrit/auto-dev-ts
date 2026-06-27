export function shouldPassModelToCodex(model: string | undefined): model is string {
  if (!model) return false;
  return !model.startsWith('claude-');
}
