import { Component, signal } from '@angular/core';
import { LandingMenuComponent } from './components/landing-menu/landing-menu.component';
import { GraphCanvasComponent } from './components/graph-canvas/graph-canvas.component';
import { DraftTimelineComponent } from './components/draft-timeline/draft-timeline.component';

type ViewMode = 'menu' | 'rfc-graph' | 'draft-timeline';

@Component({
  selector: 'app-root',
  imports: [LandingMenuComponent, GraphCanvasComponent, DraftTimelineComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  readonly view = signal<ViewMode>('menu');

  showRfcGraph(): void {
    this.view.set('rfc-graph');
  }

  showDraftTimeline(): void {
    this.view.set('draft-timeline');
  }

  backToMenu(): void {
    this.view.set('menu');
  }
}
