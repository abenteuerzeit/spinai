import { LLM } from "../llms/base";
import { Action } from "../types/action";
import { ResponseFormat } from "../types/agent";
import {
  ActionPlanner,
  ActionPlannerState,
  PlanNextActionsResult,
  ActionParametersResult,
  FormatResponseResult,
} from "../types/planner";
import {
  PLAN_NEXT_ACTIONS_SCHEMA,
  ACTION_PARAMETERS_SCHEMA,
  FORMAT_RESPONSE_SCHEMA,
  DEFAULT_TEXT_RESPONSE_SCHEMA,
} from "../types/schemas";
import {
  PLAN_NEXT_ACTIONS_PROMPT,
  GET_ACTION_PARAMETERS_PROMPT,
  FORMAT_RESPONSE_PROMPT,
  PLAN_NEXT_ACTIONS_RERUN_PROMPT,
} from "../types/prompts";
import { log } from "../utils/debugLogger";

export class BasePlanner implements ActionPlanner {
  private totalCostCents = 0;
  private instructions: string;

  constructor(
    private loggingService?: any,
    instructions: string = ""
  ) {
    this.instructions = instructions;
  }

  getTotalCost(): number {
    return this.totalCostCents;
  }

  resetCost(): void {
    this.totalCostCents = 0;
  }

  private formatState(state: ActionPlannerState): string {
    return JSON.stringify(state, null, 2);
  }

  private formatAvailableActions(actions: Action[]): string {
    return actions.map((a) => `${a.id}: ${a.description}`).join("\n");
  }

  private trackCost(costCents: number) {
    this.totalCostCents += costCents;
  }

  async planNextActions({
    llm,
    input,
    state,
    availableActions,
    isRerun,
  }: {
    llm: LLM;
    input: string;
    state: ActionPlannerState;
    availableActions: Action[];
    isRerun: boolean;
  }): Promise<PlanNextActionsResult> {
    const promptTemplate = isRerun
      ? PLAN_NEXT_ACTIONS_RERUN_PROMPT
      : PLAN_NEXT_ACTIONS_PROMPT;

    const prompt = promptTemplate
      .replace("{{instructions}}", this.instructions)
      .replace("{{state}}", this.formatState(state))
      .replace("{{input}}", input)
      .replace(
        "{{availableActions}}",
        this.formatAvailableActions(availableActions)
      );

    const startTime = Date.now();
    const result = await llm.complete<PlanNextActionsResult>({
      prompt,
      schema: PLAN_NEXT_ACTIONS_SCHEMA,
    });
    const durationMs = Date.now() - startTime;

    this.trackCost(result.costCents);

    // Log the planning result
    log(
      `Next actions: ${result.content.actions.length === 0 ? "none" : result.content.actions.join(", ")}`,
      {
        type: "llm",
        data: {
          durationMs,
          costCents: result.costCents,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          reasoning: result.content.reasoning,
          prompt,
        },
      }
    );

    if (this.loggingService) {
      this.loggingService.logEvaluation(
        state,
        result.content.reasoning,
        result.content.actions,
        llm.modelName,
        result.inputTokens,
        result.outputTokens,
        result.costCents,
        durationMs,
        result.content
      );
    }

    return result.content;
  }

  async getActionParameters({
    llm,
    action,
    input,
    state,
    availableActions,
  }: {
    llm: LLM;
    action: string;
    input: string;
    state: ActionPlannerState;
    availableActions: Action[];
  }): Promise<ActionParametersResult> {
    // Find the action definition
    const actionDef = availableActions.find((a) => a.id === action);
    if (!actionDef?.parameters) {
      throw new Error(`Action ${action} has no parameter schema defined`);
    }

    const prompt = GET_ACTION_PARAMETERS_PROMPT.replace("{{action}}", action)
      .replace("{{instructions}}", this.instructions)
      .replace("{{input}}", input)
      .replace("{{actionDescription}}", actionDef.description)
      .replace(
        "{{parameterSchema}}",
        JSON.stringify(actionDef.parameters, null, 2)
      )
      .replace("{{state}}", this.formatState(state));

    const startTime = Date.now();
    const result = await llm.complete<ActionParametersResult>({
      prompt,
      schema: {
        ...ACTION_PARAMETERS_SCHEMA,
        properties: {
          ...ACTION_PARAMETERS_SCHEMA.properties,
          parameters: actionDef.parameters,
        },
      },
    });
    const durationMs = Date.now() - startTime;

    this.trackCost(result.costCents);

    // Log the parameter generation result
    log(`Generated parameters for ${action}`, {
      type: "llm",
      data: {
        durationMs,
        costCents: result.costCents,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        reasoning: result.content.reasoning,
        parameters: result.content.parameters,
        prompt,
      },
    });

    if (this.loggingService) {
      this.loggingService.logEvaluation(
        state,
        result.content.reasoning,
        [action],
        llm.modelName,
        result.inputTokens,
        result.outputTokens,
        result.costCents,
        durationMs,
        result.content
      );
    }

    return result.content;
  }

  async formatResponse({
    llm,
    input,
    state,
    responseFormat,
  }: {
    llm: LLM;
    input: string;
    state: ActionPlannerState;
    responseFormat?: ResponseFormat;
  }): Promise<FormatResponseResult> {
    const formatInstructions =
      responseFormat?.type === "json"
        ? `Format the response as JSON matching this schema:\n${JSON.stringify(responseFormat.schema, null, 2)}`
        : "Format the response as a clear text summary of what was done and their outcomes";

    const prompt = FORMAT_RESPONSE_PROMPT.replace(
      "{{instructions}}",
      this.instructions
    )
      .replace("{{input}}", input)
      .replace("{{state}}", this.formatState(state))
      .replace("{{responseFormat}}", formatInstructions);

    const startTime = Date.now();

    if (responseFormat?.type === "json") {
      // For JSON responses, use the provided schema
      const result = await llm.complete<unknown>({
        prompt,
        schema: responseFormat.schema,
      });
      const durationMs = Date.now() - startTime;
      this.trackCost(result.costCents);

      const formattedResult = {
        response: result.content,
        reasoning: "Response formatted as JSON according to specified schema",
      };

      // Log the response generation result
      log("Generated response", {
        type: "llm",
        data: {
          durationMs,
          costCents: result.costCents,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          reasoning: formattedResult.reasoning,
          prompt,
        },
      });

      this.logResponse(formattedResult, result, durationMs, state);
      return formattedResult;
    } else {
      // For text responses or undefined format, use the default text schema
      const result = await llm.complete<FormatResponseResult>({
        prompt,
        schema: FORMAT_RESPONSE_SCHEMA,
      });
      const durationMs = Date.now() - startTime;
      this.trackCost(result.costCents);

      const formattedResult = {
        response: result.content.response,
        reasoning: result.content.reasoning,
      };

      // Log the response generation result
      log("Generated response", {
        type: "llm",
        data: {
          durationMs,
          costCents: result.costCents,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          reasoning: formattedResult.reasoning,
          prompt,
        },
      });

      this.logResponse(formattedResult, result, durationMs, state);
      return formattedResult;
    }
  }

  private logResponse(
    formattedResult: FormatResponseResult,
    result: { costCents: number; inputTokens: number; outputTokens: number },
    durationMs: number,
    state: ActionPlannerState
  ) {
    if (this.loggingService) {
      this.loggingService.logEvaluation(
        state,
        formattedResult.reasoning,
        [],
        "unknown",
        result.inputTokens,
        result.outputTokens,
        result.costCents,
        durationMs,
        formattedResult
      );
    }
  }
}
