# Pi–Kiro Bridge — Glossary

> Domain terms for `pi-kiro-models`. Implementation-free. Updated as decisions resolve.

## Pi tool passthrough

The capability that lets a Kiro-backed model discover, invoke, and receive the
real result of a tool available in its host Pi session. Advertising a tool name
or schema without supporting invocation is not passthrough.

## Exposed tool set

Pi tool passthrough exposes active extension-contributed tools in the host Pi
session, not every configured tool and not Pi's built-in coding tools. When Pi
activates or registers another extension tool, the exposed set reflects that
change on the next model turn. Kiro's own coding tools remain responsible for
ordinary file, shell, search, and web operations.

## Host-executed tool call

A tool request initiated by a Kiro-backed model but executed as a normal tool
call by the host Pi session. It has the same validation, policy checks,
visibility, result recording, and error behavior as a tool call initiated by
any other Pi-backed model.
