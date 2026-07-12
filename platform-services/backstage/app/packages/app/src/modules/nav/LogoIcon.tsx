import { makeStyles } from '@material-ui/core';
import { misLogoDataUri } from './misLogo';

// The compact "MiS" mark shown when the sidebar is collapsed. Same wordmark as LogoFull, sized
// a little smaller to sit inside the narrow closed rail. The source PNG is black on transparency
// and the collapsed rail is charcoal, so we invert it to white for contrast.
const useStyles = makeStyles({
  img: {
    height: 26,
    width: 'auto',
    display: 'block',
    // black artwork -> white on the charcoal sidebar
    filter: 'brightness(0) invert(1)',
  },
});

export const LogoIcon = () => {
  const classes = useStyles();

  return (
    <img
      className={classes.img}
      src={misLogoDataUri}
      alt="University of Alabama MIS"
    />
  );
};
