import { Component, EventEmitter, Output } from '@angular/core';

@Component({
  selector: 'app-landing-menu',
  standalone: true,
  templateUrl: './landing-menu.component.html',
  styleUrl: './landing-menu.component.scss',
})
export class LandingMenuComponent {
  @Output() selectRfcGraph = new EventEmitter<void>();
  @Output() selectDraftTimeline = new EventEmitter<void>();
}
