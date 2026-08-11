.text
.p2align 4, 0x90
.globl _cindy_simulator_kit_unmasked_surface
_cindy_simulator_kit_unmasked_surface:
    pushq %r13
    movq %rdi, %r13
    callq _$s12SimulatorKit15SimDeviceScreenC15unmaskedSurfaceSo9IOSurfaceCSgvg
    popq %r13
    retq
