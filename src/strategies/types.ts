export interface EvaluationStrategy {
  name: string;
  /** Returns tools this strategy needs injected into the Evaluator agent */
  getTools(): any[];
  /** Returns additional system prompt fragment for the Evaluator */
  getPromptFragment(): string;
}
