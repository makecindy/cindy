// Both engines give a Bash PreToolUse handler tool_input.command and accept a
// hookSpecificOutput denial. Recognize standalone filters on that contract;
// never import or execute a project script to find out what it does.
import { parser } from '@lezer/python';
import JSON5 from 'json5';
import { isPlainObject } from './hookConfig.js';

const commandInput = /^json\.load\(sys\.stdin\)(?:\[['"]tool_input['"]\]\[['"]command['"]\]|\.get\(['"]tool_input['"],\{\}\)\.get\(['"]command['"],(?:''|"")\))$/;
const pureCall = /^(?:any|all|len|re\.(?:compile|search|match|fullmatch|findall|finditer|escape)|[a-zA-Z_]\w*\.(?:group|search|match|fullmatch|startswith|endswith|split|strip))$/;

const pureSyntax = new Set([
  'Script', 'Comment', 'ExpressionStatement', 'AssignStatement', 'AssignOp', 'IfStatement', 'Body',
  'ArgList', 'ArrayComprehensionExpression', 'ArrayExpression', 'ParenthesizedExpression',
  'BinaryExpression', 'UnaryExpression', 'CompareOp', 'LogicOp', 'String', 'Boolean', 'Number',
  'if', 'elif', 'else', 'for', 'in', 'not', 'and', 'or', '.', ',', '(', ')', ':', '[', ']',
]);

type PythonNode = ReturnType<typeof parser.parse>['topNode'];

function isDenyOutput(expression: string, call: PythonNode): boolean {
  const match = /^print\(\s*json\.dumps\(\s*(\{[\s\S]*\})\s*(?:,\s*ensure_ascii\s*=\s*(?:True|False)\s*)?\)\s*\)$/.exec(expression);
  const dict = call.getChild('ArgList')?.getChild('CallExpression')?.getChild('ArgList')?.getChild('DictionaryExpression');
  if (!match || !dict) return false;
  // JSON5 accepts unquoted keys, but Python would evaluate those as variable names.
  let literal = true;
  dict.cursor().iterate(node => {
    if (!['DictionaryExpression', 'String', '{', '}', ':', ','].includes(node.name)) literal = false;
  });
  if (!literal) return false;
  try {
    const output: unknown = JSON5.parse(match[1]);
    if (!isPlainObject(output) || Object.keys(output).length !== 1) return false;
    const body = output.hookSpecificOutput;
    return isPlainObject(body) && body.hookEventName === 'PreToolUse' && body.permissionDecision === 'deny'
      && Object.keys(body).every(key => ['hookEventName', 'permissionDecision', 'permissionDecisionReason'].includes(key))
      && (body.permissionDecisionReason === undefined || typeof body.permissionDecisionReason === 'string');
  } catch {
    return false;
  }
}

export function isPortableBashGuard(source: string): boolean {
  const imports = new Set<string>();
  let usesRegex = false;
  let readsCommand = false;
  let canDeny = false;
  let compatible = true;
  parser.parse(source).iterate({
    enter(node) {
      if (!compatible) return false;
      const fragment = () => source.slice(node.from, node.to);
      if (node.type.isError) compatible = false;
      else if (node.name === 'ImportStatement') {
        compatible = /^import\s+(?:json|sys|re)(?:\s*,\s*(?:json|sys|re))*$/.test(fragment());
        if (compatible) for (const name of fragment().slice('import'.length).split(',')) imports.add(name.trim());
        return false;
      } else if (node.name === 'CallExpression' || node.name === 'MemberExpression') {
        const input = node.to - node.from < 160
          && fragment().replace(/('[^']*'|"[^"]*")|\s+/g, (_, literal: string | undefined) => literal ?? '');
        if (input && commandInput.test(input)) {
          readsCommand = true;
          return false;
        }
        if (node.name === 'CallExpression') {
          const callee = node.node.firstChild!;
          const name = source.slice(callee.from, callee.to);
          if (name === 'print') {
            compatible = isDenyOutput(fragment(), node.node);
            canDeny ||= compatible;
            return false;
          }
          usesRegex ||= name.startsWith('re.');
          compatible = pureCall.test(name);
        } else if (!node.node.getChild('PropertyName')) compatible = false;
      } else if (node.name === 'VariableName' || node.name === 'PropertyName') {
        // sys.stdin and JSON I/O have already been consumed as whole expressions.
        compatible = !/^(?:sys|json|__.*)$/.test(fragment());
      } else if (!node.type.isAnonymous) {
        compatible = pureSyntax.has(node.name);
      }
    },
  });
  return compatible && readsCommand && canDeny && imports.has('sys') && imports.has('json')
    && (!usesRegex || imports.has('re'));
}
