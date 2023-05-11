#!/usr/bin/env python3

import os
import json
import torch
from typing import Union
from transformers import AutoModelForCausalLM, AutoTokenizer
from evals.api import CompletionFn, CompletionResult
from evals.registry import Registry
from evals.cli.oaieval import get_parser, run

model_name = 'oasst-rlhf-2-llama-30b-7k-steps'
tokenizer = AutoTokenizer.from_pretrained(model_name)
model = AutoModelForCausalLM.from_pretrained(model_name, torch_dtype=torch.float16).eval().cuda()

def prompt_json_to_str(prompt):
    if isinstance(prompt, str):
        return '<|system|>' + prompt + tokenizer.eos_token + '<|assistant|>'

    prompt_str = ''
    for item in prompt:
        role = item['role']
        content = item['content']
        if role == 'system' and 'name' not in item:
            prompt_str += '<|system|>' + content + tokenizer.eos_token
        elif role == 'system' and item['name'] == 'example_assistant':
            prompt_str += '<|assistant|>' + content + tokenizer.eos_token
        elif (role == 'system' and item['name'] == 'example_user') or role == 'user':
            prompt_str += '<|prompter|>' + content + tokenizer.eos_token
        else:
            raise
    prompt_str += '<|assistant|>'
    return prompt_str

class OpenAssistantCompletionResult(CompletionResult):
    def __init__(self, response) -> None:
        self.response = response

    def get_completions(self) -> list[str]:
        return [self.response.strip()]

class OpenAssistantCompletionFn(CompletionFn):
    def __init__(self) -> None:
        pass

    def model_output(self, prompt_str):
        inputs = tokenizer(prompt_str, return_tensors="pt", padding=True).to(0)

        if "token_type_ids" in inputs:
            del inputs["token_type_ids"]

        outputs = model.generate(
            **inputs,
            early_stopping=True,
            max_new_tokens=400,
            min_new_tokens=1,
            do_sample=True,
            temperature=0.8,
            repetition_penalty=1.2,
            top_p=0.9,
            pad_token_id=tokenizer.eos_token_id,
        )

        output = tokenizer.decode(outputs[0], truncate_before_pattern=[r"\n\n^#", "^'''", "\n\n\n"])
        reply = output.split('<|assistant|>')[-1].replace(tokenizer.eos_token, '').strip()
        return reply

    def __call__(
        self,
        prompt: Union[str, list[dict[str, str]]],
        **kwargs,
    ) -> OpenAssistantCompletionResult:
        prompt_str = prompt_json_to_str(prompt)
        output = self.model_output(prompt_str)
        return OpenAssistantCompletionResult(output)

class RegistryWithOpenAssistant(Registry):
    def make_completion_fn(self, name: str) -> CompletionFn:
        assert name == 'oasst_completion_fn'
        return OpenAssistantCompletionFn()

    api_model_ids = []

def run_eval(registry, eval_name):
    parser = get_parser()
    args = parser.parse_args(['oasst_completion_fn', eval_name,
        '--record_path', 'runs/' + eval_name + '.json'])

    import logging
    logging.basicConfig(
        format="[%(asctime)s] [%(filename)s:%(lineno)d] %(message)s",
        level=logging.INFO,
        filename=args.log_to_file if args.log_to_file else None,
    )

    import openai
    logging.getLogger("openai").setLevel(logging.WARN)
    if hasattr(openai.error, "set_display_cause"):
        openai.error.set_display_cause()

    run(args, registry)

def run_multiple_evals(registry, evals):
    ignored_evals = [
        'best.dev.v0', # Compares multiple models
        'positive-binary-operations.test.v1', # buggy
        'spider-sql.dev.v0',
        'sarcasm.test.v1',
        'svg_understanding.v0', # CUDA out of memory
        'decrypt-caesar-cipher.dev.v0'
    ]

    for eval in evals:
        if os.path.exists(os.path.join('runs/', eval.key + '.json')):
            continue
        if eval.key in ignored_evals:
            continue
        print('Now evaluating', eval.key)
        run_eval(registry, eval.key)

def run_eval_set(registry, eval_set_name):
    run_multiple_evals(registry, registry.get_evals(registry.get_eval_set(eval_set_name).evals))

def run_all_evals(registry):
    run_multiple_evals(registry, registry.get_evals(['*']))

def build_run_index():
    specs_and_final_reports = {}
    for filename in os.listdir('runs/'):
        with open(os.path.join('runs/', filename), 'r') as f:
            spec_and_final_report = f.read().split('\n')[:2]
            spec = spec_and_final_report[0]
            final_report = spec_and_final_report[1]
            specs_and_final_reports[filename] = { 'spec': json.loads(spec)['spec'], 'final_report': json.loads(final_report)['final_report'] }
    with open('runs/__index__.json', 'w') as f:
        json.dump(specs_and_final_reports, f, indent=4)

def main():
    os.environ['EVALS_THREADS'] = '1'
    os.environ['EVALS_THREAD_TIMEOUT'] = '999999'
    registry = RegistryWithOpenAssistant()
    run_all_evals(registry)
    build_run_index()

if __name__ == '__main__':
    main()
