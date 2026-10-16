// Push-to-talk capture: hands every block of the first input channel to the
// page, which keeps them until the button is let go.
class OfaRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) this.port.postMessage(channel.slice(0))
    return true
  }
}
registerProcessor('ofa-recorder', OfaRecorder)
