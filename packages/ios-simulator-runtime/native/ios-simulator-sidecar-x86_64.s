.text
.p2align 4, 0x90
.globl _cindy_simulator_kit_unmasked_surface
_cindy_simulator_kit_unmasked_surface:
    pushq %r13
    movq %rdi, %r13
    // The second argument is the getter resolved from the selected Xcode.
    callq *%rsi
    popq %r13
    retq
