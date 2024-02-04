export class Pointer {
  constructor(event) {
    this.event = event;
    this.pageX = event.pageX;
    this.pageY = event.pageY;
    this.clientX = event.clientX;
    this.clientY = event.clientY;
    this.id = event.pointerId;
    this.type = event.pointerType;
    this.buttons = event.buttons ?? -1;
  }

  getCoalesced() {
    return this.event.getCoalescedEvents().map((p) => new Pointer(p));
  }
}
